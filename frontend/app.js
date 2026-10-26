/**
 * GeoPulse Live GPS Dashboard Controller
 * Real-time GPS Telemetry & Map Visualization
 */

// State Management
const state = {
  backendUrl: getSavedBackendUrl(),
  apiKey: localStorage.getItem('gps_api_key') || '',
  latestPoint: null,
  history: [],
  autoRecenter: true,
  showTrail: true,
  currentLayerKey: 'positron',
  eventSource: null,
  lastPingTimestamp: null,
  pollingTimer: null
};

// DOM Elements
const elements = {
  connStatusBadge: document.getElementById('connStatusBadge'),
  connStatusText: document.getElementById('connStatusText'),
  valLatitude: document.getElementById('valLatitude'),
  valLongitude: document.getElementById('valLongitude'),
  valSpeed: document.getElementById('valSpeed'),
  valSpeedMph: document.getElementById('valSpeedMph'),
  valSatellites: document.getElementById('valSatellites'),
  valAltitude: document.getElementById('valAltitude'),
  valDistance: document.getElementById('valDistance'),
  valPointsCount: document.getElementById('valPointsCount'),
  valLastTimeAgo: document.getElementById('valLastTimeAgo'),
  valExactTime: document.getElementById('valExactTime'),
  movementStatus: document.getElementById('movementStatus'),
  fixQualityBadge: document.getElementById('fixQualityBadge'),
  signalBars: document.getElementById('signalBars'),
  speedBar: document.getElementById('speedBar'),
  gmapsLink: document.getElementById('gmapsLink'),
  copyCoordsBtn: document.getElementById('copyCoordsBtn'),
  copyCoordsText: document.getElementById('copyCoordsText'),
  recenterBtn: document.getElementById('recenterBtn'),
  toggleTrailBtn: document.getElementById('toggleTrailBtn'),
  clearTrailBtn: document.getElementById('clearTrailBtn'),
  simulateBtn: document.getElementById('simulateBtn'),
  overlaySimulateBtn: document.getElementById('overlaySimulateBtn'),
  mapWaitingOverlay: document.getElementById('mapWaitingOverlay'),
  logsCountBadge: document.getElementById('logsCountBadge'),
  logsTableBody: document.getElementById('logsTableBody'),
  toggleLogsBtn: document.getElementById('toggleLogsBtn'),
  logsBody: document.getElementById('logsBody'),
  settingsBtn: document.getElementById('settingsBtn'),
  settingsModal: document.getElementById('settingsModal'),
  closeSettingsBtn: document.getElementById('closeSettingsBtn'),
  saveSettingsBtn: document.getElementById('saveSettingsBtn'),
  resetServerUrlBtn: document.getElementById('resetServerUrlBtn'),
  serverUrlInput: document.getElementById('serverUrlInput'),
  apiKeyInput: document.getElementById('apiKeyInput'),
  displayTargetEndpoint: document.getElementById('displayTargetEndpoint')
};

// ================= Map Setup =================
let map, marker, trailPolyline, baseTileLayers;

function initMap() {
  // Default center (World view / default before fix)
  const defaultCoords = [28.6139, 77.2090]; // Delhi India Gate default
  
  map = L.map('map', {
    center: defaultCoords,
    zoom: 15,
    zoomControl: false
  });

  // Put zoom controls on bottom right
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // Map Tile Providers (White & Clean Theme)
  baseTileLayers = {
    positron: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 20
    }),
    osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19
    }),
    satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
      maxZoom: 19
    })
  };

  // Add default clean light layer
  baseTileLayers.positron.addTo(map);

  // Initialize Trail Polyline
  trailPolyline = L.polyline([], {
    color: '#2563eb',
    weight: 4,
    opacity: 0.85,
    lineJoin: 'round',
    dashArray: null
  }).addTo(map);

  // Custom DivIcon for Tracker with Pulsing Radar
  const customIcon = L.divIcon({
    className: 'custom-gps-marker',
    html: `
      <div class="marker-ripple"></div>
      <div class="marker-beacon"></div>
    `,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  marker = L.marker(defaultCoords, { icon: customIcon });
}

// ================= URL & Connection Handling =================
function getSavedBackendUrl() {
  const saved = localStorage.getItem('gps_backend_url');
  if (saved && saved.trim() !== '') {
    return saved.trim().replace(/\/$/, '');
  }
  // If hosted on Render, use same origin
  if (window.location.protocol.startsWith('http')) {
    return window.location.origin;
  }
  // If running from file://, default to localhost:3000
  return 'http://localhost:3000';
}

function updateConnectionBadge(status, text) {
  elements.connStatusBadge.className = `status-pill status-${status}`;
  elements.connStatusText.textContent = text;
}

// ================= Real-Time Stream (SSE) =================
function startRealtimeStream() {
  if (state.eventSource) {
    state.eventSource.close();
  }

  const streamUrl = `${state.backendUrl}/api/location/stream`;
  console.log(`Connecting to SSE stream at ${streamUrl}...`);
  updateConnectionBadge('connecting', 'Connecting...');

  try {
    state.eventSource = new EventSource(streamUrl);

    state.eventSource.addEventListener('connected', () => {
      console.log('SSE connection established');
      updateConnectionBadge('online', 'LIVE CONNECTED');
    });

    state.eventSource.addEventListener('location', (e) => {
      try {
        const point = JSON.parse(e.data);
        handleNewLocation(point);
        updateConnectionBadge('online', 'LIVE CONNECTED');
      } catch (err) {
        console.error('Error parsing SSE location payload:', err);
      }
    });

    state.eventSource.addEventListener('history_cleared', () => {
      state.history = [];
      trailPolyline.setLatLngs([]);
      updateDistanceUI();
      elements.valPointsCount.textContent = '0 points';
      elements.logsTableBody.innerHTML = '<tr class="empty-row"><td colspan="7">History cleared. Waiting for next packet...</td></tr>';
      elements.logsCountBadge.textContent = '0 pings';
    });

    state.eventSource.onerror = (err) => {
      console.warn('SSE connection warning/error:', err);
      updateConnectionBadge('connecting', 'Reconnecting...');
    };
  } catch (err) {
    console.error('EventSource initialization failed:', err);
    updateConnectionBadge('offline', 'OFFLINE');
  }

  // Backup polling every 6 seconds to ensure data stays fresh
  if (state.pollingTimer) clearInterval(state.pollingTimer);
  state.pollingTimer = setInterval(fetchInitialLocation, 6000);
}

// Fetch existing points from backend
async function fetchInitialLocation() {
  try {
    const res = await fetch(`${state.backendUrl}/api/location`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.history && Array.isArray(data.history) && data.history.length > 0) {
      state.history = data.history;
      renderHistoryPolyline(state.history);
      elements.valPointsCount.textContent = `${state.history.length} points`;
      elements.logsCountBadge.textContent = `${state.history.length} pings`;
      renderLogsTable(state.history.slice(-15).reverse());
    }

    if (data.latest) {
      handleNewLocation(data.latest, false);
    }
  } catch (err) {
    console.warn('Could not fetch latest location from backend:', err.message);
  }
}

// ================= Location Handling =================
function handleNewLocation(point, addToHistory = true) {
  if (!point || typeof point.latitude !== 'number' || typeof point.longitude !== 'number') return;

  state.latestPoint = point;
  state.lastPingTimestamp = new Date(point.timestamp || Date.now());

  // Hide the "Waiting for GPS fix" overlay once coordinates arrive
  elements.mapWaitingOverlay.classList.add('hidden');

  const latLng = [point.latitude, point.longitude];

  // Update Map Marker
  if (!map.hasLayer(marker)) {
    marker.addTo(map);
  }
  marker.setLatLng(latLng);

  // Auto-center map if enabled
  if (state.autoRecenter) {
    map.panTo(latLng, { animate: true, duration: 0.8 });
  }

  // Update Polyline
  if (addToHistory) {
    state.history.push(point);
    trailPolyline.addLatLng(latLng);
    elements.valPointsCount.textContent = `${state.history.length} points`;
    elements.logsCountBadge.textContent = `${state.history.length} pings`;
    appendLogTableRow(point);
  }

  // Update UI Telemetry
  updateTelemetryUI(point);
  updateDistanceUI();
}

function updateTelemetryUI(point) {
  elements.valLatitude.textContent = point.latitude.toFixed(6);
  elements.valLongitude.textContent = point.longitude.toFixed(6);

  const speedKmph = point.speed || 0;
  const speedMph = speedKmph * 0.621371;

  elements.valSpeed.textContent = speedKmph.toFixed(1);
  elements.valSpeedMph.textContent = speedMph.toFixed(1);

  // Speed bar (assuming 0-120 km/h max gauge)
  const barPercent = Math.min(100, Math.max(0, (speedKmph / 100) * 100));
  elements.speedBar.style.width = `${barPercent}%`;

  // Movement Status
  if (speedKmph > 2) {
    elements.movementStatus.textContent = 'Moving';
    elements.movementStatus.className = 'chip chip-green';
  } else {
    elements.movementStatus.textContent = 'Stationary';
    elements.movementStatus.className = 'chip chip-gray';
  }

  // Satellites
  const sats = point.satellites || 0;
  elements.valSatellites.textContent = sats;

  // Signal Bars & Fix Quality
  updateSatelliteBars(sats);

  // Altitude
  elements.valAltitude.textContent = point.altitude ? point.altitude.toFixed(1) : '--';

  // Google Maps Link
  elements.gmapsLink.href = `https://www.google.com/maps?q=${point.latitude},${point.longitude}`;

  // Exact time
  const dateObj = new Date(point.timestamp || Date.now());
  elements.valExactTime.textContent = dateObj.toLocaleTimeString();
}

function updateSatelliteBars(sats) {
  const bars = elements.signalBars.querySelectorAll('.bar');
  bars.forEach(b => b.style.background = '#cbd5e1');

  if (sats >= 1) bars[0].style.background = '#8b5cf6';
  if (sats >= 4) bars[1].style.background = '#8b5cf6';
  if (sats >= 7) bars[2].style.background = '#8b5cf6';
  if (sats >= 10) bars[3].style.background = '#8b5cf6';

  if (sats >= 8) {
    elements.fixQualityBadge.textContent = 'Strong 3D Fix';
    elements.fixQualityBadge.className = 'chip chip-green';
  } else if (sats >= 4) {
    elements.fixQualityBadge.textContent = 'Good Fix';
    elements.fixQualityBadge.className = 'chip chip-blue';
  } else if (sats > 0) {
    elements.fixQualityBadge.textContent = 'Weak Fix';
    elements.fixQualityBadge.className = 'chip chip-amber';
  } else {
    elements.fixQualityBadge.textContent = 'Searching';
    elements.fixQualityBadge.className = 'chip chip-gray';
  }
}

// Render full polyline from history
function renderHistoryPolyline(historyPoints) {
  const latLngs = historyPoints.map(p => [p.latitude, p.longitude]);
  trailPolyline.setLatLngs(latLngs);
  updateDistanceUI();
}

// Calculate total distance using Haversine formula
function updateDistanceUI() {
  if (state.history.length < 2) {
    elements.valDistance.textContent = '0.00';
    return;
  }

  let totalDistanceKm = 0;
  for (let i = 1; i < state.history.length; i++) {
    const p1 = state.history[i - 1];
    const p2 = state.history[i];
    totalDistanceKm += haversineDistance(p1.latitude, p1.longitude, p2.latitude, p2.longitude);
  }

  elements.valDistance.textContent = totalDistanceKm.toFixed(2);
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ================= Table Logs =================
function appendLogTableRow(point) {
  const emptyRow = elements.logsTableBody.querySelector('.empty-row');
  if (emptyRow) emptyRow.remove();

  const timeStr = new Date(point.timestamp || Date.now()).toLocaleTimeString();
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="mono">${timeStr}</td>
    <td class="mono">${point.latitude.toFixed(6)}</td>
    <td class="mono">${point.longitude.toFixed(6)}</td>
    <td>${(point.speed || 0).toFixed(1)}</td>
    <td>${point.satellites || 0}</td>
    <td>${point.altitude ? point.altitude.toFixed(1) : '--'} m</td>
    <td>
      <a href="https://www.google.com/maps?q=${point.latitude},${point.longitude}" target="_blank" class="footer-link">Map</a>
    </td>
  `;

  // Prepend to top
  elements.logsTableBody.insertBefore(tr, elements.logsTableBody.firstChild);

  // Keep table bounded
  while (elements.logsTableBody.children.length > 25) {
    elements.logsTableBody.removeChild(elements.logsTableBody.lastChild);
  }
}

function renderLogsTable(points) {
  if (!points || points.length === 0) return;
  elements.logsTableBody.innerHTML = '';
  points.forEach(point => appendLogTableRow(point));
}

// ================= Live "Last Updated" Counter =================
setInterval(() => {
  if (!state.lastPingTimestamp) {
    elements.valLastTimeAgo.textContent = 'Waiting for data';
    return;
  }

  const seconds = Math.floor((Date.now() - state.lastPingTimestamp.getTime()) / 1000);
  if (seconds < 2) {
    elements.valLastTimeAgo.textContent = 'Just now';
  } else if (seconds < 60) {
    elements.valLastTimeAgo.textContent = `${seconds}s ago`;
  } else {
    const mins = Math.floor(seconds / 60);
    elements.valLastTimeAgo.textContent = `${mins}m ${seconds % 60}s ago`;
  }
}, 1000);

// ================= Interactive Controls =================

// Recenter Map on current marker
elements.recenterBtn.addEventListener('click', () => {
  state.autoRecenter = true;
  elements.recenterBtn.classList.add('active-state');
  if (state.latestPoint) {
    map.setView([state.latestPoint.latitude, state.latestPoint.longitude], 16, { animate: true });
  }
});

// Disable autoRecenter if user manually drags map
map.on('dragstart', () => {
  state.autoRecenter = false;
  elements.recenterBtn.classList.remove('active-state');
});

// Toggle Trail Polyline
elements.toggleTrailBtn.addEventListener('click', () => {
  state.showTrail = !state.showTrail;
  if (state.showTrail) {
    trailPolyline.addTo(map);
    elements.toggleTrailBtn.querySelector('span').textContent = 'Trail: ON';
    elements.toggleTrailBtn.classList.add('active-state');
  } else {
    map.removeLayer(trailPolyline);
    elements.toggleTrailBtn.querySelector('span').textContent = 'Trail: OFF';
    elements.toggleTrailBtn.classList.remove('active-state');
  }
});

// Clear Trail History
elements.clearTrailBtn.addEventListener('click', async () => {
  if (!confirm('Are you sure you want to clear the route trail history?')) return;
  try {
    await fetch(`${state.backendUrl}/api/location/history`, { method: 'DELETE' });
  } catch (err) {
    console.error('Failed to clear history on backend:', err);
    // Local clear
    state.history = [];
    trailPolyline.setLatLngs([]);
    updateDistanceUI();
  }
});

// Map Layer Switcher
document.querySelectorAll('.layer-pill').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('.layer-pill').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');

    const selected = e.target.getAttribute('data-layer');
    if (selected === state.currentLayerKey) return;

    map.removeLayer(baseTileLayers[state.currentLayerKey]);
    baseTileLayers[selected].addTo(map);
    state.currentLayerKey = selected;
  });
});

// Copy Coordinates
elements.copyCoordsBtn.addEventListener('click', () => {
  if (!state.latestPoint) return;
  const text = `${state.latestPoint.latitude.toFixed(6)}, ${state.latestPoint.longitude.toFixed(6)}`;
  navigator.clipboard.writeText(text).then(() => {
    elements.copyCoordsText.textContent = 'Copied!';
    setTimeout(() => {
      elements.copyCoordsText.textContent = 'Copy';
    }, 2000);
  });
});

// Simulate Ping (For Instant Testing)
async function triggerSimulation() {
  try {
    elements.simulateBtn.classList.add('btn-primary');
    const res = await fetch(`${state.backendUrl}/api/simulate`, { method: 'POST' });
    const data = await res.json();
    console.log('Simulation response:', data);
  } catch (err) {
    alert(`Could not trigger simulation: ${err.message}. Ensure backend is running.`);
  } finally {
    setTimeout(() => {
      elements.simulateBtn.classList.remove('btn-primary');
    }, 600);
  }
}

elements.simulateBtn.addEventListener('click', triggerSimulation);
elements.overlaySimulateBtn.addEventListener('click', triggerSimulation);

// Toggle Logs Drawer
elements.toggleLogsBtn.addEventListener('click', () => {
  const isCollapsed = elements.logsBody.classList.toggle('collapsed');
  const span = elements.toggleLogsBtn.querySelector('span');
  const chevron = elements.toggleLogsBtn.querySelector('.chevron');
  if (isCollapsed) {
    span.textContent = 'Show Details';
    chevron.style.transform = 'rotate(0deg)';
  } else {
    span.textContent = 'Hide Details';
    chevron.style.transform = 'rotate(180deg)';
  }
});

// ================= Settings Modal =================
elements.settingsBtn.addEventListener('click', () => {
  elements.serverUrlInput.value = localStorage.getItem('gps_backend_url') || '';
  elements.apiKeyInput.value = localStorage.getItem('gps_api_key') || '';
  updateTargetEndpointDisplay();
  elements.settingsModal.classList.add('show');
});

elements.closeSettingsBtn.addEventListener('click', () => {
  elements.settingsModal.classList.remove('show');
});

elements.settingsModal.addEventListener('click', (e) => {
  if (e.target === elements.settingsModal) {
    elements.settingsModal.classList.remove('show');
  }
});

elements.serverUrlInput.addEventListener('input', updateTargetEndpointDisplay);

function updateTargetEndpointDisplay() {
  const base = elements.serverUrlInput.value.trim() || window.location.origin;
  elements.displayTargetEndpoint.textContent = `${base.replace(/\/$/, '')}/api/location`;
}

elements.saveSettingsBtn.addEventListener('click', () => {
  const url = elements.serverUrlInput.value.trim();
  const key = elements.apiKeyInput.value.trim();

  if (url) {
    localStorage.setItem('gps_backend_url', url);
  } else {
    localStorage.removeItem('gps_backend_url');
  }

  if (key) {
    localStorage.setItem('gps_api_key', key);
  } else {
    localStorage.removeItem('gps_api_key');
  }

  state.backendUrl = getSavedBackendUrl();
  state.apiKey = key;
  elements.settingsModal.classList.remove('show');

  // Reconnect
  startRealtimeStream();
  fetchInitialLocation();
});

elements.resetServerUrlBtn.addEventListener('click', () => {
  localStorage.removeItem('gps_backend_url');
  localStorage.removeItem('gps_api_key');
  elements.serverUrlInput.value = '';
  elements.apiKeyInput.value = '';
  updateTargetEndpointDisplay();
});

// ================= Boot Application =================
window.addEventListener('DOMContentLoaded', () => {
  initMap();
  startRealtimeStream();
  fetchInitialLocation();
});
