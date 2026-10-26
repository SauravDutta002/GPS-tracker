import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import L from 'leaflet';
import {
  LuSatellite,
  LuMapPin,
  LuGauge,
  LuClock,
  LuRoute,
  LuMountain,
  LuCopy,
  LuCheck,
  LuExternalLink,
  LuLocateFixed,
  LuTrash2,
  LuChevronUp,
  LuChevronDown,
  LuPlay,
  LuMaximize,
  LuMinimize,
  LuWifi,
  LuWifiOff,
  LuNavigation,
  LuSpline,
  LuRadar,
  LuScanSearch
} from 'react-icons/lu';
import { BACKEND_URL, API_KEY } from './config';

const MAX_POINTS = 500;
const jsonHeaders = { 'Content-Type': 'application/json', 'x-api-key': API_KEY };

// A hop faster than this (or a gap longer than this) starts a new trail segment,
// so simulated pings or long outages don't draw lines across the country.
const MAX_PLAUSIBLE_KMH = 250;
const MAX_GAP_KM = 2;
// Moves smaller than this are GPS jitter and don't count toward distance.
const JITTER_KM = 0.004;

// Tracker counts as online if it pinged (heartbeat or fix) within this window.
const ONLINE_TIMEOUT_MS = 30_000;

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Split history into continuous segments and sum real travel distance.
function analyseTrack(points) {
  const segments = [];
  let current = [];
  let km = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[i - 1];
    if (prev) {
      const d = haversineDistance(prev.latitude, prev.longitude, p.latitude, p.longitude);
      const hours = Math.max(1, new Date(p.timestamp) - new Date(prev.timestamp)) / 3_600_000;
      const isJump = d > MAX_GAP_KM || d / hours > MAX_PLAUSIBLE_KMH;
      if (isJump) {
        if (current.length) segments.push(current);
        current = [];
      } else if (d > JITTER_KM) {
        km += d;
      }
    }
    current.push([p.latitude, p.longitude]);
  }
  if (current.length) segments.push(current);
  return { segments, km };
}

function fixQuality(sats) {
  if (sats >= 8) return { label: 'Strong fix', tone: 'green' };
  if (sats >= 4) return { label: 'Good fix', tone: 'blue' };
  if (sats > 0) return { label: 'Weak fix', tone: 'amber' };
  return { label: 'No fix', tone: 'gray' };
}

function timeAgo(timestamp) {
  if (!timestamp) return 'Waiting for data';
  const s = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (s < 3) return 'Just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

// Google Maps tiles: m = roadmap, y = satellite + labels, p = terrain
const google = (lyrs) =>
  L.tileLayer(`https://mt{s}.google.com/vt/lyrs=${lyrs}&x={x}&y={y}&z={z}`, {
    subdomains: '0123',
    maxZoom: 21,
    attribution: '&copy; Google Maps'
  });

const LAYERS = [
  { key: 'map', label: 'Map' },
  { key: 'satellite', label: 'Satellite' },
  { key: 'terrain', label: 'Terrain' }
];

export default function App() {
  const [latestPoint, setLatestPoint] = useState(null);
  const [device, setDevice] = useState(null); // { lastSeen, hasFix, satellites }
  const [laptopPos, setLaptopPos] = useState(null);
  const [history, setHistory] = useState([]);
  const [connection, setConnection] = useState('connecting'); // online | connecting | offline
  const [autoRecenter, setAutoRecenter] = useState(true);
  const [showTrail, setShowTrail] = useState(false);
  const [layer, setLayer] = useState('map');
  const [copied, setCopied] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const mapEl = useRef(null);
  const map = useRef(null);
  const marker = useRef(null);
  const startMarker = useRef(null);
  const accuracy = useRef(null);
  const trail = useRef(null);
  const trailGlow = useRef(null);
  const tiles = useRef({});
  const autoRecenterRef = useRef(true);
  const lastSource = useRef(null);

  useEffect(() => {
    autoRecenterRef.current = autoRecenter;
  }, [autoRecenter]);

  const track = useMemo(() => analyseTrack(history), [history]);

  // ---------- Map ----------
  useEffect(() => {
    if (!mapEl.current || map.current) return;

    const m = L.map(mapEl.current, {
      center: [20.5937, 78.9629],
      zoom: 5,
      zoomControl: false,
      zoomSnap: 0.5
    });
    L.control.zoom({ position: 'bottomright' }).addTo(m);
    L.control.scale({ position: 'bottomleft', imperial: false }).addTo(m);

    tiles.current = {
      map: google('m'),
      satellite: google('y'),
      terrain: google('p')
    };
    tiles.current.map.addTo(m);

    trailGlow.current = L.polyline([], { color: '#2563eb', weight: 8, opacity: 0.15, lineCap: 'round', lineJoin: 'round' }).addTo(m);
    trail.current = L.polyline([], { color: '#2563eb', weight: 3.5, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(m);
    accuracy.current = L.circle([0, 0], { radius: 12, color: '#2563eb', weight: 1, fillColor: '#2563eb', fillOpacity: 0.08 });

    marker.current = L.marker([0, 0], {
      icon: L.divIcon({
        className: 'gps-marker',
        html: '<span class="gps-ripple"></span><span class="gps-ripple r2"></span><span class="gps-dot"></span>',
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      }),
      zIndexOffset: 1000
    });
    startMarker.current = L.marker([0, 0], {
      icon: L.divIcon({ className: 'start-marker', html: '<span></span>', iconSize: [14, 14], iconAnchor: [7, 7] }),
      title: 'Trail start'
    });

    m.on('dragstart', () => setAutoRecenter(false));
    map.current = m;

    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    Object.entries(tiles.current).forEach(([key, l]) => {
      if (key === layer) l.addTo(m);
      else m.removeLayer(l);
    });
  }, [layer]);

  // Draw the trail from history (multi-segment polyline)
  useEffect(() => {
    const m = map.current;
    if (!m || !trail.current) return;
    const { segments } = track;
    trail.current.setLatLngs(segments);
    trailGlow.current.setLatLngs(segments);

    const current = segments[segments.length - 1];
    if (showTrail && current && current.length > 1) {
      startMarker.current.setLatLng(current[0]).addTo(m);
    } else {
      m.removeLayer(startMarker.current);
    }
  }, [track, showTrail]);

  useEffect(() => {
    const m = map.current;
    if (!m || !trail.current) return;
    [trailGlow.current, trail.current].forEach((l) => (showTrail ? l.addTo(m) : m.removeLayer(l)));
  }, [showTrail]);

  useEffect(() => {
    const t = setTimeout(() => map.current?.invalidateSize(), 250);
    return () => clearTimeout(t);
  }, [fullscreen, showLogs]);

  const placeMarker = useCallback((point, source) => {
    const m = map.current;
    if (!m || !marker.current) return;
    if (!point) {
      m.removeLayer(marker.current);
      m.removeLayer(accuracy.current);
      lastSource.current = null;
      return;
    }
    const ll = [point.latitude, point.longitude];
    if (!m.hasLayer(marker.current)) {
      marker.current.addTo(m);
      accuracy.current.addTo(m);
    }
    marker.current.setLatLng(ll);
    accuracy.current.setLatLng(ll).setRadius(point.accuracy || 12);
    if (lastSource.current !== source) {
      // jump straight there when the location first appears or switches laptop <-> device
      lastSource.current = source;
      m.setView(ll, 18);
    } else if (autoRecenterRef.current) {
      m.panTo(ll, { animate: true, duration: 0.8 });
    }
  }, []);

  const handleNewPoint = useCallback(
    (point) => {
      if (!point || typeof point.latitude !== 'number' || typeof point.longitude !== 'number') return;
      setLatestPoint(point);
      setHistory((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.timestamp === point.timestamp) return prev;
        const next = [...prev, point];
        return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next;
      });
    },
    []
  );

  // ---------- Data: initial fetch + SSE + polling backup ----------
  useEffect(() => {
    let es;
    let alive = true;

    fetch(`${BACKEND_URL}/api/location`)
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        setHistory(Array.isArray(data.history) ? data.history : []);
        if (data.latest) setLatestPoint(data.latest);
        if (data.device) setDevice(data.device);
        setConnection('online');
      })
      .catch(() => alive && setConnection('offline'));

    try {
      es = new EventSource(`${BACKEND_URL}/api/location/stream`);
      es.addEventListener('connected', () => setConnection('online'));
      es.addEventListener('location', (e) => {
        try {
          handleNewPoint(JSON.parse(e.data));
          setConnection('online');
        } catch {
          /* ignore malformed packet */
        }
      });
      es.addEventListener('device', (e) => {
        try {
          setDevice(JSON.parse(e.data));
        } catch {
          /* ignore malformed packet */
        }
      });
      es.addEventListener('history_cleared', () => setHistory([]));
      es.onerror = () => setConnection((c) => (c === 'online' ? 'connecting' : c));
    } catch {
      setConnection('offline');
    }

    const poll = setInterval(() => {
      fetch(`${BACKEND_URL}/api/location`)
        .then((r) => r.json())
        .then((d) => {
          if (d.latest) handleNewPoint(d.latest);
          if (d.device) setDevice(d.device);
          setConnection('online');
        })
        .catch(() => {});
    }, 6000);

    return () => {
      alive = false;
      es?.close();
      clearInterval(poll);
    };
  }, [handleNewPoint]);

  // re-render every second so "x s ago" stays live
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // ---------- Derived ----------
  // No location at all until the tracker is online. Online without a 3D fix -> this
  // browser's location. Online with a 3D fix -> the tracker's own GPS position.
  const deviceOnline = !!device?.lastSeen && now - new Date(device.lastSeen).getTime() < ONLINE_TIMEOUT_MS;
  const hasFix =
    deviceOnline &&
    !!latestPoint &&
    (latestPoint.satellites || 0) >= 4 &&
    now - new Date(latestPoint.timestamp).getTime() < ONLINE_TIMEOUT_MS;
  const live = hasFix ? latestPoint : null;
  const source = !deviceOnline ? null : hasFix ? 'device' : 'laptop';
  const position = source === 'device' ? live : source === 'laptop' ? laptopPos : null;

  // Watch the browser's location only while it's the one being shown
  useEffect(() => {
    if (source !== 'laptop' || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) =>
        setLaptopPos({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: Math.min(pos.coords.accuracy || 0, 2000)
        }),
      () => setLaptopPos(null),
      { enableHighAccuracy: true, maximumAge: 10_000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [source]);

  useEffect(() => {
    placeMarker(position, source);
  }, [position?.latitude, position?.longitude, source, placeMarker]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- Actions ----------
  const recenter = () => {
    setAutoRecenter(true);
    if (position) map.current?.setView([position.latitude, position.longitude], 18, { animate: true });
  };

  const fitTrip = () => {
    const current = track.segments[track.segments.length - 1];
    if (!current?.length) return;
    setAutoRecenter(false);
    map.current?.fitBounds(L.latLngBounds(current), { padding: [70, 70], maxZoom: 17 });
  };

  const copyCoords = () => {
    if (!position) return;
    navigator.clipboard
      .writeText(`${position.latitude.toFixed(6)}, ${position.longitude.toFixed(6)}`)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      });
  };

  const clearHistory = async () => {
    if (!window.confirm('Clear the route trail history?')) return;
    try {
      await fetch(`${BACKEND_URL}/api/location/history`, { method: 'DELETE', headers: jsonHeaders });
    } catch {
      /* local clear still applies */
    }
    setHistory(latestPoint ? [latestPoint] : []);
  };

  const simulate = async () => {
    try {
      await fetch(`${BACKEND_URL}/api/simulate`, { method: 'POST', headers: jsonHeaders });
    } catch (err) {
      alert(`Simulation failed: ${err.message}`);
    }
  };

  const speed = live?.speed || 0;
  const sats = live?.satellites || 0;
  const fix = fixQuality(sats);
  const km = track.km;
  const isMoving = speed > 2;
  const status =
    connection === 'offline'
      ? { cls: 'offline', text: 'Server offline' }
      : deviceOnline
      ? { cls: 'online', text: 'Live' }
      : { cls: 'connecting', text: 'Tracker offline' };
  const gmaps = position ? `https://www.google.com/maps?q=${position.latitude},${position.longitude}` : '#';

  return (
    <div className={`app ${fullscreen ? 'is-fullscreen' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-logo">
            <LuSatellite />
          </div>
          <div>
            <h1>GeoPulse</h1>
            <p>ESP8266 · Neo-6M live tracker</p>
          </div>
        </div>

        <div className="topbar-actions">
          <span className="last-seen">
            <LuClock /> {timeAgo(device?.lastSeen)}
          </span>
          <span className={`status status-${status.cls}`}>
            {deviceOnline ? <LuWifi /> : <LuWifiOff />}
            {status.text}
            <i className="status-dot" />
          </span>
          <button className="btn" onClick={simulate} title="Send a simulated GPS packet">
            <LuPlay /> <span>Simulate</span>
          </button>
        </div>
      </header>

      <div className="layout">
        <aside className="panel">
          <section className="card hero-card">
            <div className="card-head">
              <span className="icon blue"><LuMapPin /></span>
              <span className="label">Current position</span>
              <button className="chip-btn" onClick={copyCoords} disabled={!position} title="Copy coordinates">
                {copied ? <LuCheck /> : <LuCopy />}
              </button>
            </div>
            <div className="coords">
              <div><small>Latitude</small><b className="mono">{position ? position.latitude.toFixed(6) : '--.------'}</b></div>
              <div><small>Longitude</small><b className="mono">{position ? position.longitude.toFixed(6) : '--.------'}</b></div>
            </div>
            <div className="hero-foot">
              <span className={`tag tag-${isMoving ? 'green' : 'gray'}`}>
                <i className="tag-dot" /> {isMoving ? 'Moving' : 'Stationary'}
              </span>
              <a className="link" href={gmaps} target="_blank" rel="noopener noreferrer">
                Google Maps <LuExternalLink />
              </a>
            </div>
          </section>

          <div className="grid-2">
            <section className="card stat">
              <div className="stat-head"><span className="icon green"><LuGauge /></span>Speed</div>
              <div className="big"><b className="mono">{speed.toFixed(1)}</b><span>km/h</span></div>
              <div className="bar"><i style={{ width: `${Math.min(100, speed)}%` }} /></div>
            </section>

            <section className="card stat">
              <div className="stat-head"><span className="icon purple"><LuRadar /></span>Satellites</div>
              <div className="big">
                <b className="mono">{sats}</b>
                <div className="sat-bars">
                  {[1, 4, 7, 10].map((n, i) => (
                    <i key={n} className={sats >= n ? 'on' : ''} style={{ height: 5 + i * 4 }} />
                  ))}
                </div>
              </div>
              <span className={`tag tag-${fix.tone}`}>{fix.label}</span>
            </section>

            <section className="card stat">
              <div className="stat-head">
                <span className="icon amber"><LuRoute /></span>Distance
                <button className="mini-btn" onClick={clearHistory} title="Clear trail history"><LuTrash2 /></button>
              </div>
              <div className="big">
                <b className="mono">{km < 1 ? (km * 1000).toFixed(0) : km.toFixed(2)}</b>
                <span>{km < 1 ? 'm' : 'km'}</span>
              </div>
              <small className="muted">{history.length} points</small>
            </section>

            <section className="card stat">
              <div className="stat-head"><span className="icon teal"><LuMountain /></span>Altitude</div>
              <div className="big"><b className="mono">{live?.altitude ? live.altitude.toFixed(0) : '--'}</b><span>m</span></div>
              <small className="muted">above sea level</small>
            </section>
          </div>

          <section className="card recent">
            <div className="stat-head"><span className="icon blue"><LuClock /></span>Recent pings</div>
            {history.length === 0 ? (
              <small className="muted">No packets yet.</small>
            ) : (
              <ul>
                {history.slice(-5).reverse().map((p, i) => (
                  <li key={`${p.timestamp}-${i}`}>
                    <span className="mono">{p.timestamp ? new Date(p.timestamp).toLocaleTimeString() : '--'}</span>
                    <span className="mono muted">{(p.speed || 0).toFixed(1)} km/h</span>
                    <span className="mono muted">{p.satellites || 0} sats</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

        </aside>

        <main className="map-wrap">
          <div ref={mapEl} className="map" />

          <div className="map-toolbar">
            <div className="seg">
              {LAYERS.map((l) => (
                <button key={l.key} className={layer === l.key ? 'active' : ''} onClick={() => setLayer(l.key)}>
                  {l.label}
                </button>
              ))}
            </div>
            <div className="tools">
              <button className={`tool ${autoRecenter ? 'active' : ''}`} onClick={recenter} title="Follow tracker">
                <LuLocateFixed />
              </button>
              <button className="tool" onClick={fitTrip} title="Fit whole trip">
                <LuScanSearch />
              </button>
              <button className={`tool ${showTrail ? 'active' : ''}`} onClick={() => setShowTrail((v) => !v)} title="Toggle trail">
                <LuSpline />
              </button>
              <button className="tool" onClick={() => setFullscreen((v) => !v)} title="Fullscreen map">
                {fullscreen ? <LuMinimize /> : <LuMaximize />}
              </button>
            </div>
          </div>

          {live && (
            <div className="map-hud">
              <div><small>Speed</small><b className="mono">{speed.toFixed(1)}<em>km/h</em></b></div>
              <div><small>Sats</small><b className="mono">{sats}</b></div>
              <div><small>Trip</small><b className="mono">{km < 1 ? `${(km * 1000).toFixed(0)}` : km.toFixed(2)}<em>{km < 1 ? 'm' : 'km'}</em></b></div>
            </div>
          )}

          {!position && (
            <div className="empty">
              <div className="radar"><i /><i /><i /><LuNavigation /></div>
              <h3>{deviceOnline ? 'Getting location…' : 'Tracker offline'}</h3>
              <p>
                {deviceOnline
                  ? 'Allow location access in your browser to see where you are while the GPS gets a fix.'
                  : 'The location will appear once the ESP8266 connects to the internet.'}
              </p>
            </div>
          )}
        </main>
      </div>

      <section className="logs card">
        <button className="logs-head" onClick={() => setShowLogs((v) => !v)}>
          <span><LuSatellite /> Packet log <em>{history.length}</em></span>
          {showLogs ? <LuChevronDown /> : <LuChevronUp />}
        </button>
        {showLogs && (
          <div className="logs-body">
            <table>
              <thead>
                <tr><th>Time</th><th>Latitude</th><th>Longitude</th><th>km/h</th><th>Sats</th><th>Alt</th><th /></tr>
              </thead>
              <tbody>
                {history.length === 0 ? (
                  <tr><td colSpan={7} className="muted">No packets yet.</td></tr>
                ) : (
                  [...history].reverse().slice(0, 30).map((p, i) => (
                    <tr key={`${p.timestamp}-${i}`}>
                      <td className="mono">{p.timestamp ? new Date(p.timestamp).toLocaleTimeString() : '--'}</td>
                      <td className="mono">{p.latitude.toFixed(6)}</td>
                      <td className="mono">{p.longitude.toFixed(6)}</td>
                      <td>{(p.speed || 0).toFixed(1)}</td>
                      <td>{p.satellites || 0}</td>
                      <td>{p.altitude ? p.altitude.toFixed(0) : '--'} m</td>
                      <td><a className="link" href={`https://www.google.com/maps?q=${p.latitude},${p.longitude}`} target="_blank" rel="noopener noreferrer">Map</a></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
