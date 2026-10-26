import React, { useState, useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import {
  Satellite,
  MapPin,
  Gauge,
  Clock,
  Settings,
  Play,
  Copy,
  Check,
  ExternalLink,
  Crosshair,
  Trash2,
  ChevronDown,
  ChevronUp,
  X,
  Compass
} from 'lucide-react';

// Haversine distance helper
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

export default function App() {
  // Backend URL resolution
  const [backendUrl, setBackendUrl] = useState(() => {
    const saved = localStorage.getItem('gps_backend_url');
    if (saved && saved.trim() !== '') return saved.trim().replace(/\/$/, '');
    if (window.location.protocol.startsWith('http')) {
      // In dev mode (port 5173), default to localhost:3000
      if (window.location.port === '5173') return 'http://localhost:3000';
      return window.location.origin;
    }
    return 'http://localhost:3000';
  });

  const [apiKey, setApiKey] = useState(() => localStorage.getItem('gps_api_key') || '');

  // State
  const [latestPoint, setLatestPoint] = useState(null);
  const [history, setHistory] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState('connecting'); // 'online' | 'connecting' | 'offline'
  const [autoRecenter, setAutoRecenter] = useState(true);
  const [showTrail, setShowTrail] = useState(true);
  const [currentLayer, setCurrentLayer] = useState('positron');
  const [copied, setCopied] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [lastPingAgo, setLastPingAgo] = useState('Waiting for data');

  // Input states in settings modal
  const [tempUrl, setTempUrl] = useState(backendUrl);
  const [tempKey, setTempKey] = useState(apiKey);

  // Map Refs
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markerRef = useRef(null);
  const polylineRef = useRef(null);
  const tileLayersRef = useRef({});

  // 1. Initialize Leaflet Map
  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    const defaultCoords = [28.6139, 77.2090]; // Delhi India Gate default
    const map = L.map(mapContainerRef.current, {
      center: defaultCoords,
      zoom: 15,
      zoomControl: false
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Map Tile Layers
    const layers = {
      positron: L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 20
      }),
      osm: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 19
      }),
      satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri',
        maxZoom: 19
      })
    };

    layers.positron.addTo(map);
    tileLayersRef.current = layers;

    // Trail Polyline
    const polyline = L.polyline([], {
      color: '#2563eb',
      weight: 4,
      opacity: 0.85,
      lineJoin: 'round'
    }).addTo(map);
    polylineRef.current = polyline;

    // Animated GPS Beacon Marker
    const customIcon = L.divIcon({
      className: 'custom-gps-marker',
      html: `
        <div class="marker-ripple"></div>
        <div class="marker-beacon"></div>
      `,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    const marker = L.marker(defaultCoords, { icon: customIcon });
    markerRef.current = marker;

    // Turn off auto-recenter when user drags map manually
    map.on('dragstart', () => {
      setAutoRecenter(false);
    });

    mapInstanceRef.current = map;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  // 2. Switch Map Tile Layers
  const handleLayerChange = (layerKey) => {
    const map = mapInstanceRef.current;
    if (!map) return;
    const layers = tileLayersRef.current;

    if (layers[currentLayer]) map.removeLayer(layers[currentLayer]);
    if (layers[layerKey]) layers[layerKey].addTo(map);
    setCurrentLayer(layerKey);
  };

  // 3. Connect to Server-Sent Events (SSE) & Initial Fetch
  const handleNewPoint = useCallback((point) => {
    if (!point || typeof point.latitude !== 'number' || typeof point.longitude !== 'number') return;

    setLatestPoint(point);
    setHistory(prev => {
      const updated = [...prev, point];
      // Keep up to 500 points
      return updated.length > 500 ? updated.slice(-500) : updated;
    });

    // Update map marker
    const map = mapInstanceRef.current;
    const marker = markerRef.current;
    const polyline = polylineRef.current;

    if (map && marker) {
      const latLng = [point.latitude, point.longitude];
      if (!map.hasLayer(marker)) {
        marker.addTo(map);
      }
      marker.setLatLng(latLng);

      if (polyline) {
        polyline.addLatLng(latLng);
      }

      // Pan to new coordinate if auto-recenter is enabled
      setAutoRecenter(current => {
        if (current) {
          map.panTo(latLng, { animate: true, duration: 0.8 });
        }
        return current;
      });
    }
  }, []);

  // Initial Fetch & SSE Setup
  useEffect(() => {
    let eventSource = null;
    let pollTimer = null;

    const streamUrl = `${backendUrl}/api/location/stream`;
    setConnectionStatus('connecting');

    // Initial fetch of existing points
    fetch(`${backendUrl}/api/location`)
      .then(res => res.json())
      .then(data => {
        if (data.history && Array.isArray(data.history) && data.history.length > 0) {
          setHistory(data.history);
          if (polylineRef.current) {
            polylineRef.current.setLatLngs(data.history.map(p => [p.latitude, p.longitude]));
          }
        }
        if (data.latest) {
          setLatestPoint(data.latest);
          if (markerRef.current && mapInstanceRef.current) {
            markerRef.current.addTo(mapInstanceRef.current);
            markerRef.current.setLatLng([data.latest.latitude, data.latest.longitude]);
            mapInstanceRef.current.setView([data.latest.latitude, data.latest.longitude], 15);
          }
        }
      })
      .catch(err => console.warn('Could not fetch initial location:', err.message));

    // Connect SSE
    try {
      eventSource = new EventSource(streamUrl);

      eventSource.addEventListener('connected', () => {
        setConnectionStatus('online');
      });

      eventSource.addEventListener('location', (e) => {
        try {
          const point = JSON.parse(e.data);
          handleNewPoint(point);
          setConnectionStatus('online');
        } catch (err) {
          console.error('Error parsing SSE location:', err);
        }
      });

      eventSource.addEventListener('history_cleared', () => {
        setHistory([]);
        if (polylineRef.current) {
          polylineRef.current.setLatLngs([]);
        }
      });

      eventSource.onerror = () => {
        setConnectionStatus('connecting');
      };
    } catch (err) {
      console.error('EventSource failed:', err);
      setConnectionStatus('offline');
    }

    // Polling backup every 6s
    pollTimer = setInterval(() => {
      fetch(`${backendUrl}/api/location`)
        .then(r => r.json())
        .then(d => {
          if (d.latest) handleNewPoint(d.latest);
        })
        .catch(() => {});
    }, 6000);

    return () => {
      if (eventSource) eventSource.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [backendUrl, handleNewPoint]);

  // 4. Live "Last Updated" Counter
  useEffect(() => {
    const timer = setInterval(() => {
      if (!latestPoint || !latestPoint.timestamp) {
        setLastPingAgo('Waiting for data');
        return;
      }
      const seconds = Math.floor((Date.now() - new Date(latestPoint.timestamp).getTime()) / 1000);
      if (seconds < 2) {
        setLastPingAgo('Just now');
      } else if (seconds < 60) {
        setLastPingAgo(`${seconds}s ago`);
      } else {
        const mins = Math.floor(seconds / 60);
        setLastPingAgo(`${mins}m ${seconds % 60}s ago`);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [latestPoint]);

  // Recenter map button
  const handleRecenter = () => {
    setAutoRecenter(true);
    if (latestPoint && mapInstanceRef.current) {
      mapInstanceRef.current.setView([latestPoint.latitude, latestPoint.longitude], 16, { animate: true });
    }
  };

  // Toggle Trail
  const handleToggleTrail = () => {
    const map = mapInstanceRef.current;
    const polyline = polylineRef.current;
    if (!map || !polyline) return;

    if (showTrail) {
      map.removeLayer(polyline);
      setShowTrail(false);
    } else {
      polyline.addTo(map);
      setShowTrail(true);
    }
  };

  // Copy coordinates
  const handleCopyCoords = () => {
    if (!latestPoint) return;
    const text = `${latestPoint.latitude.toFixed(6)}, ${latestPoint.longitude.toFixed(6)}`;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // Clear history
  const handleClearHistory = async () => {
    if (!window.confirm('Are you sure you want to clear route trail history?')) return;
    try {
      await fetch(`${backendUrl}/api/location/history`, { method: 'DELETE' });
    } catch (err) {
      console.error('Failed to clear history:', err);
    }
    setHistory([]);
    if (polylineRef.current) polylineRef.current.setLatLngs([]);
  };

  // Simulate ping
  const handleSimulate = async () => {
    try {
      await fetch(`${backendUrl}/api/simulate`, { method: 'POST' });
    } catch (err) {
      alert(`Simulation failed: ${err.message}. Ensure backend is running.`);
    }
  };

  // Save Settings Modal
  const handleSaveSettings = () => {
    const cleanUrl = tempUrl.trim();
    const cleanKey = tempKey.trim();

    if (cleanUrl) {
      localStorage.setItem('gps_backend_url', cleanUrl);
      setBackendUrl(cleanUrl);
    } else {
      localStorage.removeItem('gps_backend_url');
      setBackendUrl(window.location.origin);
    }

    if (cleanKey) {
      localStorage.setItem('gps_api_key', cleanKey);
      setApiKey(cleanKey);
    } else {
      localStorage.removeItem('gps_api_key');
      setApiKey('');
    }

    setShowSettings(false);
  };

  // Reset Settings
  const handleResetSettings = () => {
    localStorage.removeItem('gps_backend_url');
    localStorage.removeItem('gps_api_key');
    const defUrl = window.location.port === '5173' ? 'http://localhost:3000' : window.location.origin;
    setTempUrl(defUrl);
    setTempKey('');
    setBackendUrl(defUrl);
    setApiKey('');
  };

  // Derived metrics
  const speedKmph = latestPoint?.speed || 0;
  const speedMph = (speedKmph * 0.621371).toFixed(1);
  const speedBarWidth = Math.min(100, Math.max(0, (speedKmph / 100) * 100));

  let totalDistanceKm = 0;
  for (let i = 1; i < history.length; i++) {
    totalDistanceKm += haversineDistance(
      history[i - 1].latitude,
      history[i - 1].longitude,
      history[i].latitude,
      history[i].longitude
    );
  }

  const sats = latestPoint?.satellites || 0;
  let fixQualityText = 'Searching';
  let fixQualityClass = 'chip-gray';
  if (sats >= 8) {
    fixQualityText = 'Strong 3D Fix';
    fixQualityClass = 'chip-green';
  } else if (sats >= 4) {
    fixQualityText = 'Good Fix';
    fixQualityClass = 'chip-blue';
  } else if (sats > 0) {
    fixQualityText = 'Weak Fix';
    fixQualityClass = 'chip-amber';
  }

  const gmapsUrl = latestPoint
    ? `https://www.google.com/maps?q=${latestPoint.latitude},${latestPoint.longitude}`
    : '#';

  return (
    <div className="app-container">
      {/* Top Navbar */}
      <header className="top-nav">
        <div className="nav-left">
          <div className="logo-box">
            <Satellite className="satellite-icon" />
            <span className="live-pulse-ring"></span>
          </div>
          <div className="brand-text">
            <h1>GeoPulse <span>React Live</span></h1>
            <p className="subtitle">ESP8266 + Neo-6M GPS Telemetry Dashboard</p>
          </div>
        </div>

        <div className="nav-right">
          {/* Connection Status Pill */}
          <div className={`status-pill status-${connectionStatus}`}>
            <span className="pill-dot"></span>
            <span className="pill-text">
              {connectionStatus === 'online'
                ? 'LIVE CONNECTED'
                : connectionStatus === 'connecting'
                ? 'Connecting...'
                : 'OFFLINE'}
            </span>
          </div>

          <div className="header-actions">
            <button onClick={handleSimulate} className="btn btn-secondary" title="Simulate incoming GPS packet">
              <Play size={16} />
              <span>Simulate Ping</span>
            </button>

            <button onClick={() => setShowSettings(true)} className="btn btn-icon" title="Server Connection Settings">
              <Settings size={18} />
            </button>
          </div>
        </div>
      </header>

      {/* Telemetry Metric Cards */}
      <section className="telemetry-grid">
        {/* Card 1: Coordinates */}
        <div className="card metric-card">
          <div className="card-header">
            <div className="card-icon blue">
              <MapPin size={18} />
            </div>
            <span className="card-label">CURRENT COORDINATES</span>
            <button onClick={handleCopyCoords} className="copy-chip" title="Copy to clipboard">
              {copied ? <Check size={12} /> : <Copy size={12} />}
              <span>{copied ? 'Copied!' : 'Copy'}</span>
            </button>
          </div>
          <div className="coords-display">
            <div className="coord-row">
              <span className="coord-tag">LAT</span>
              <span className="coord-val mono">
                {latestPoint ? latestPoint.latitude.toFixed(6) : '--.------'}
              </span>
            </div>
            <div className="coord-row">
              <span className="coord-tag">LNG</span>
              <span className="coord-val mono">
                {latestPoint ? latestPoint.longitude.toFixed(6) : '--.------'}
              </span>
            </div>
          </div>
          <div className="card-footer">
            <a href={gmapsUrl} target="_blank" rel="noopener noreferrer" className="footer-link">
              <span>View on Google Maps</span>
              <ExternalLink size={13} />
            </a>
          </div>
        </div>

        {/* Card 2: Speed / Velocity */}
        <div className="card metric-card">
          <div className="card-header">
            <div className="card-icon emerald">
              <Gauge size={18} />
            </div>
            <span className="card-label">CURRENT SPEED</span>
            <span className={`chip ${speedKmph > 2 ? 'chip-green' : 'chip-gray'}`}>
              {speedKmph > 2 ? 'Moving' : 'Stationary'}
            </span>
          </div>
          <div className="metric-main">
            <div className="metric-big-num">
              <span className="mono">{speedKmph.toFixed(1)}</span>
              <span className="unit">km/h</span>
            </div>
            <div className="metric-sub-num">
              ≈ <span className="mono">{speedMph}</span> mph
            </div>
          </div>
          <div className="card-footer">
            <div className="progress-bar-bg">
              <div className="progress-bar-fill" style={{ width: `${speedBarWidth}%` }}></div>
            </div>
          </div>
        </div>

        {/* Card 3: Satellites */}
        <div className="card metric-card">
          <div className="card-header">
            <div className="card-icon purple">
              <Compass size={18} />
            </div>
            <span className="card-label">SATELLITES IN VIEW</span>
            <span className={`chip ${fixQualityClass}`}>{fixQualityText}</span>
          </div>
          <div className="metric-main">
            <div className="metric-big-num">
              <span className="mono">{sats}</span>
              <span className="unit">sats</span>
            </div>
            <div className="satellite-signal-bars">
              <span className="bar bar-1" style={{ background: sats >= 1 ? '#8b5cf6' : '#cbd5e1' }}></span>
              <span className="bar bar-2" style={{ background: sats >= 4 ? '#8b5cf6' : '#cbd5e1' }}></span>
              <span className="bar bar-3" style={{ background: sats >= 7 ? '#8b5cf6' : '#cbd5e1' }}></span>
              <span className="bar bar-4" style={{ background: sats >= 10 ? '#8b5cf6' : '#cbd5e1' }}></span>
            </div>
          </div>
          <div className="card-footer text-muted">
            <span>Altitude: <strong className="mono">{latestPoint?.altitude ? latestPoint.altitude.toFixed(1) : '--'}</strong> m</span>
          </div>
        </div>

        {/* Card 4: Distance & Route */}
        <div className="card metric-card">
          <div className="card-header">
            <div className="card-icon amber">
              <Crosshair size={18} />
            </div>
            <span className="card-label">TRAVEL DISTANCE</span>
            <span className="chip chip-blue">{history.length} points</span>
          </div>
          <div className="metric-main">
            <div className="metric-big-num">
              <span className="mono">{totalDistanceKm.toFixed(2)}</span>
              <span className="unit">km</span>
            </div>
            <div className="metric-sub-num">Total path length</div>
          </div>
          <div className="card-footer actions-footer">
            <button onClick={handleClearHistory} className="link-btn text-danger">
              Clear History
            </button>
          </div>
        </div>

        {/* Card 5: Last Update */}
        <div className="card metric-card">
          <div className="card-header">
            <div className="card-icon teal">
              <Clock size={18} />
            </div>
            <span className="card-label">LAST PING</span>
          </div>
          <div className="metric-main">
            <div className="metric-big-num text-sm">
              <span>{lastPingAgo}</span>
            </div>
            <div className="metric-sub-num mono">
              {latestPoint?.timestamp
                ? new Date(latestPoint.timestamp).toLocaleTimeString()
                : '--:--:--'}
            </div>
          </div>
          <div className="card-footer text-muted">
            <span>Interval: ~5 seconds</span>
          </div>
        </div>
      </section>

      {/* Main Map Canvas */}
      <main className="map-section">
        <div className="map-card card">
          {/* Floating Controls Overlay */}
          <div className="map-overlay-bar">
            <div className="overlay-left">
              <button
                onClick={handleRecenter}
                className={`map-btn ${autoRecenter ? 'active-state' : ''}`}
                title="Recenter on tracker"
              >
                <Crosshair size={15} />
                <span>Recenter</span>
              </button>

              <button
                onClick={handleToggleTrail}
                className={`map-btn ${showTrail ? 'active-state' : ''}`}
                title="Toggle route trail"
              >
                <MapPin size={15} />
                <span>{showTrail ? 'Trail: ON' : 'Trail: OFF'}</span>
              </button>
            </div>

            <div className="overlay-right">
              <div className="map-layers-group">
                <button
                  onClick={() => handleLayerChange('positron')}
                  className={`layer-pill ${currentLayer === 'positron' ? 'active' : ''}`}
                >
                  Minimal Light
                </button>
                <button
                  onClick={() => handleLayerChange('osm')}
                  className={`layer-pill ${currentLayer === 'osm' ? 'active' : ''}`}
                >
                  Street
                </button>
                <button
                  onClick={() => handleLayerChange('satellite')}
                  className={`layer-pill ${currentLayer === 'satellite' ? 'active' : ''}`}
                >
                  Satellite
                </button>
              </div>
            </div>
          </div>

          {/* Leaflet Map Div */}
          <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }}></div>

          {/* Empty Waiting Overlay */}
          {!latestPoint && (
            <div className="map-empty-overlay">
              <div className="empty-state-box">
                <div className="radar-scan-anim">
                  <div className="circle c1"></div>
                  <div className="circle c2"></div>
                  <div className="circle c3"></div>
                  <div className="radar-line"></div>
                </div>
                <h3>Waiting for GPS Coordinates</h3>
                <p>
                  Ensure your ESP8266 is powered on, connected to WiFi, and the Neo-6M GPS antenna has clear line of sight to open sky.
                </p>
                <div className="empty-actions">
                  <button onClick={handleSimulate} className="btn btn-primary">
                    Try Simulated Location
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Recent Packet Logs Drawer */}
      <section className="logs-section">
        <div className="card logs-card">
          <div className="logs-header">
            <div className="logs-title">
              <Satellite size={18} />
              <h3>Live Packet Stream</h3>
              <span className="badge">{history.length} pings</span>
            </div>
            <button
              onClick={() => setShowLogs(v => !v)}
              className="btn btn-subtle text-sm"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              <span>{showLogs ? 'Hide Details' : 'Show Details'}</span>
              {showLogs ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
          </div>

          {showLogs && (
            <div className="logs-body">
              <table className="logs-table">
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Latitude</th>
                    <th>Longitude</th>
                    <th>Speed (km/h)</th>
                    <th>Satellites</th>
                    <th>Altitude</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {history.length === 0 ? (
                    <tr className="empty-row">
                      <td colSpan={7}>No packets received yet. Power on ESP8266 or click "Simulate Ping".</td>
                    </tr>
                  ) : (
                    [...history]
                      .reverse()
                      .slice(0, 20)
                      .map((p, idx) => (
                        <tr key={idx}>
                          <td className="mono">{new Date(p.timestamp || Date.now()).toLocaleTimeString()}</td>
                          <td className="mono">{p.latitude.toFixed(6)}</td>
                          <td className="mono">{p.longitude.toFixed(6)}</td>
                          <td>{(p.speed || 0).toFixed(1)}</td>
                          <td>{p.satellites || 0}</td>
                          <td>{p.altitude ? p.altitude.toFixed(1) : '--'} m</td>
                          <td>
                            <a
                              href={`https://www.google.com/maps?q=${p.latitude},${p.longitude}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="footer-link"
                            >
                              Map
                            </a>
                          </td>
                        </tr>
                      ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Settings Modal */}
      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Backend Server Connection</h3>
              <button onClick={() => setShowSettings(false)} className="modal-close">
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <p className="modal-desc">
                By default, this dashboard connects to your local or Render backend. If deployed separately, enter your Render service URL below.
              </p>

              <div className="form-group">
                <label>Backend URL (Render or Localhost)</label>
                <input
                  type="url"
                  value={tempUrl}
                  onChange={e => setTempUrl(e.target.value)}
                  placeholder="https://your-gps-server.onrender.com"
                />
                <small className="form-help">Leave empty for same origin.</small>
              </div>

              <div className="form-group">
                <label>API Key (x-api-key)</label>
                <input
                  type="text"
                  value={tempKey}
                  onChange={e => setTempKey(e.target.value)}
                  placeholder="YOUR_SECRET_API_KEY"
                />
                <small className="form-help">Matches the API_KEY environment variable on Render.</small>
              </div>

              <div className="modal-info-box">
                <strong>ESP8266 Target Endpoint:</strong>
                <code>{`${(tempUrl || window.location.origin).replace(/\/$/, '')}/api/location`}</code>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={handleResetSettings} className="btn btn-secondary">
                Reset Default
              </button>
              <button onClick={handleSaveSettings} className="btn btn-primary">
                Save & Connect
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
