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
  LuNavigation,
  LuWifi,
  LuWifiOff,
  LuActivity,
  LuSpline,
  LuRadar
} from 'react-icons/lu';
import { BACKEND_URL, API_KEY } from './config';

const MAX_POINTS = 500;
const jsonHeaders = { 'Content-Type': 'application/json', 'x-api-key': API_KEY };

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fixQuality(sats) {
  if (sats >= 8) return { label: 'Strong fix', tone: 'green' };
  if (sats >= 4) return { label: 'Good fix', tone: 'blue' };
  if (sats > 0) return { label: 'Weak fix', tone: 'amber' };
  return { label: 'Searching', tone: 'gray' };
}

function timeAgo(timestamp) {
  if (!timestamp) return 'Waiting for data';
  const s = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (s < 3) return 'Just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

const LAYERS = [
  { key: 'dark', label: 'Dark' },
  { key: 'streets', label: 'Streets' },
  { key: 'satellite', label: 'Satellite' }
];

export default function App() {
  const [latestPoint, setLatestPoint] = useState(null);
  const [history, setHistory] = useState([]);
  const [connection, setConnection] = useState('connecting'); // online | connecting | offline
  const [autoRecenter, setAutoRecenter] = useState(true);
  const [showTrail, setShowTrail] = useState(true);
  const [layer, setLayer] = useState('dark');
  const [copied, setCopied] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [, setTick] = useState(0);

  const mapEl = useRef(null);
  const map = useRef(null);
  const marker = useRef(null);
  const accuracy = useRef(null);
  const trail = useRef(null);
  const trailGlow = useRef(null);
  const tiles = useRef({});
  const autoRecenterRef = useRef(true);

  useEffect(() => {
    autoRecenterRef.current = autoRecenter;
  }, [autoRecenter]);

  // ---------- Map ----------
  useEffect(() => {
    if (!mapEl.current || map.current) return;

    const m = L.map(mapEl.current, {
      center: [20.5937, 78.9629],
      zoom: 5,
      zoomControl: false,
      zoomSnap: 0.5,
      attributionControl: true
    });
    L.control.zoom({ position: 'bottomright' }).addTo(m);
    L.control.scale({ position: 'bottomleft', imperial: false }).addTo(m);

    const carto = (style) =>
      L.tileLayer(`https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`, {
        attribution: '&copy; OpenStreetMap &copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 20
      });

    tiles.current = {
      dark: carto('dark_all'),
      streets: carto('rastertiles/voyager'),
      satellite: L.layerGroup([
        L.tileLayer(
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          { attribution: 'Tiles &copy; Esri', maxZoom: 19 }
        ),
        L.tileLayer(
          'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
          { maxZoom: 19 }
        )
      ])
    };
    tiles.current.dark.addTo(m);

    trailGlow.current = L.polyline([], { color: '#38bdf8', weight: 10, opacity: 0.18, lineCap: 'round' }).addTo(m);
    trail.current = L.polyline([], { color: '#38bdf8', weight: 4, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(m);
    accuracy.current = L.circle([0, 0], { radius: 15, color: '#38bdf8', weight: 1, fillColor: '#38bdf8', fillOpacity: 0.12 });

    marker.current = L.marker([0, 0], {
      icon: L.divIcon({
        className: 'gps-marker',
        html: '<span class="gps-ripple"></span><span class="gps-ripple r2"></span><span class="gps-dot"></span>',
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      }),
      zIndexOffset: 1000
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
    // keep trail above imagery
    trailGlow.current?.bringToFront();
    trail.current?.bringToFront();
  }, [layer]);

  useEffect(() => {
    const m = map.current;
    if (!m || !trail.current) return;
    if (showTrail) {
      trail.current.addTo(m);
      trailGlow.current.addTo(m);
    } else {
      m.removeLayer(trail.current);
      m.removeLayer(trailGlow.current);
    }
  }, [showTrail]);

  useEffect(() => {
    const t = setTimeout(() => map.current?.invalidateSize(), 250);
    return () => clearTimeout(t);
  }, [fullscreen, showLogs]);

  const placeMarker = useCallback((point, { jump = false } = {}) => {
    const m = map.current;
    if (!m || !marker.current) return;
    const ll = [point.latitude, point.longitude];
    if (!m.hasLayer(marker.current)) {
      marker.current.addTo(m);
      accuracy.current.addTo(m);
    }
    marker.current.setLatLng(ll);
    accuracy.current.setLatLng(ll);
    if (jump) m.setView(ll, 17);
    else if (autoRecenterRef.current) m.panTo(ll, { animate: true, duration: 0.8 });
  }, []);

  const handleNewPoint = useCallback(
    (point) => {
      if (!point || typeof point.latitude !== 'number' || typeof point.longitude !== 'number') return;
      setLatestPoint(point);
      setHistory((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.timestamp === point.timestamp) return prev;
        trail.current?.addLatLng([point.latitude, point.longitude]);
        trailGlow.current?.addLatLng([point.latitude, point.longitude]);
        const next = [...prev, point];
        return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next;
      });
      placeMarker(point);
    },
    [placeMarker]
  );

  // ---------- Data: initial fetch + SSE + polling backup ----------
  useEffect(() => {
    let es;
    let alive = true;

    fetch(`${BACKEND_URL}/api/location`)
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        const pts = Array.isArray(data.history) ? data.history : [];
        setHistory(pts);
        const ll = pts.map((p) => [p.latitude, p.longitude]);
        trail.current?.setLatLngs(ll);
        trailGlow.current?.setLatLngs(ll);
        if (data.latest) {
          setLatestPoint(data.latest);
          placeMarker(data.latest, { jump: true });
        }
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
      es.addEventListener('history_cleared', () => {
        setHistory([]);
        trail.current?.setLatLngs([]);
        trailGlow.current?.setLatLngs([]);
      });
      es.onerror = () => setConnection((c) => (c === 'online' ? 'connecting' : c));
    } catch {
      setConnection('offline');
    }

    const poll = setInterval(() => {
      fetch(`${BACKEND_URL}/api/location`)
        .then((r) => r.json())
        .then((d) => {
          if (d.latest) handleNewPoint(d.latest);
          setConnection('online');
        })
        .catch(() => {});
    }, 6000);

    return () => {
      alive = false;
      es?.close();
      clearInterval(poll);
    };
  }, [handleNewPoint, placeMarker]);

  // re-render every second so "x s ago" stays live
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // ---------- Actions ----------
  const recenter = () => {
    setAutoRecenter(true);
    if (latestPoint) map.current?.setView([latestPoint.latitude, latestPoint.longitude], 17, { animate: true });
  };

  const copyCoords = () => {
    if (!latestPoint) return;
    navigator.clipboard
      .writeText(`${latestPoint.latitude.toFixed(6)}, ${latestPoint.longitude.toFixed(6)}`)
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
    setHistory([]);
    trail.current?.setLatLngs([]);
    trailGlow.current?.setLatLngs([]);
  };

  const simulate = async () => {
    try {
      await fetch(`${BACKEND_URL}/api/simulate`, { method: 'POST', headers: jsonHeaders });
    } catch (err) {
      alert(`Simulation failed: ${err.message}`);
    }
  };

  // ---------- Derived ----------
  const speed = latestPoint?.speed || 0;
  const sats = latestPoint?.satellites || 0;
  const fix = fixQuality(sats);
  const totalKm = useMemo(() => {
    let d = 0;
    for (let i = 1; i < history.length; i++) {
      d += haversineDistance(history[i - 1].latitude, history[i - 1].longitude, history[i].latitude, history[i].longitude);
    }
    return d;
  }, [history]);

  const statusText = { online: 'Live', connecting: 'Connecting', offline: 'Offline' }[connection];
  const gmaps = latestPoint ? `https://www.google.com/maps?q=${latestPoint.latitude},${latestPoint.longitude}` : '#';

  return (
    <div className={`app ${fullscreen ? 'is-fullscreen' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-logo">
            <LuSatellite />
          </div>
          <div>
            <h1>GeoPulse</h1>
            <p>ESP8266 + Neo-6M live tracker</p>
          </div>
        </div>

        <div className="topbar-actions">
          <span className={`status status-${connection}`}>
            {connection === 'offline' ? <LuWifiOff /> : <LuWifi />}
            <i className="status-dot" />
            {statusText}
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
              <span className="label">Position</span>
              <button className="chip-btn" onClick={copyCoords} disabled={!latestPoint}>
                {copied ? <LuCheck /> : <LuCopy />} {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="coords">
              <div><small>LAT</small><b className="mono">{latestPoint ? latestPoint.latitude.toFixed(6) : '--.------'}</b></div>
              <div><small>LNG</small><b className="mono">{latestPoint ? latestPoint.longitude.toFixed(6) : '--.------'}</b></div>
            </div>
            <a className="link" href={gmaps} target="_blank" rel="noopener noreferrer">
              Open in Google Maps <LuExternalLink />
            </a>
          </section>

          <div className="grid-2">
            <section className="card stat">
              <div className="card-head">
                <span className="icon green"><LuGauge /></span>
                <span className="label">Speed</span>
              </div>
              <div className="big"><b className="mono">{speed.toFixed(1)}</b><span>km/h</span></div>
              <div className="bar"><i style={{ width: `${Math.min(100, speed)}%` }} /></div>
              <small className="muted">{speed > 2 ? 'Moving' : 'Stationary'} · {(speed * 0.621371).toFixed(1)} mph</small>
            </section>

            <section className="card stat">
              <div className="card-head">
                <span className="icon purple"><LuRadar /></span>
                <span className="label">Satellites</span>
              </div>
              <div className="big"><b className="mono">{sats}</b><span>sats</span></div>
              <div className="sat-bars">
                {[1, 4, 7, 10].map((n, i) => (
                  <i key={n} className={sats >= n ? 'on' : ''} style={{ height: 6 + i * 5 }} />
                ))}
              </div>
              <span className={`tag tag-${fix.tone}`}>{fix.label}</span>
            </section>

            <section className="card stat">
              <div className="card-head">
                <span className="icon amber"><LuRoute /></span>
                <span className="label">Distance</span>
              </div>
              <div className="big"><b className="mono">{totalKm < 1 ? (totalKm * 1000).toFixed(0) : totalKm.toFixed(2)}</b><span>{totalKm < 1 ? 'm' : 'km'}</span></div>
              <small className="muted">{history.length} points logged</small>
              <button className="link danger" onClick={clearHistory}><LuTrash2 /> Clear trail</button>
            </section>

            <section className="card stat">
              <div className="card-head">
                <span className="icon teal"><LuMountain /></span>
                <span className="label">Altitude</span>
              </div>
              <div className="big"><b className="mono">{latestPoint?.altitude ? latestPoint.altitude.toFixed(0) : '--'}</b><span>m</span></div>
              <small className="muted">above sea level</small>
            </section>
          </div>

          <section className="card ping">
            <span className="icon teal"><LuClock /></span>
            <div>
              <b>{timeAgo(latestPoint?.timestamp)}</b>
              <small className="muted mono">
                {latestPoint?.timestamp ? new Date(latestPoint.timestamp).toLocaleTimeString() : '--:--:--'}
              </small>
            </div>
            <LuActivity className={`pulse ${connection === 'online' ? 'on' : ''}`} />
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
              <button className={`tool ${showTrail ? 'active' : ''}`} onClick={() => setShowTrail((v) => !v)} title="Toggle trail">
                <LuSpline />
              </button>
              <button className="tool" onClick={() => setFullscreen((v) => !v)} title="Fullscreen map">
                {fullscreen ? <LuMinimize /> : <LuMaximize />}
              </button>
            </div>
          </div>

          {!latestPoint && (
            <div className="empty">
              <div className="radar"><i /><i /><i /><LuNavigation /></div>
              <h3>Waiting for GPS coordinates</h3>
              <p>Power the ESP8266 and keep the Neo-6M antenna under open sky. The first fix can take a few minutes.</p>
              <button className="btn primary" onClick={simulate}><LuPlay /> Try simulated location</button>
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
