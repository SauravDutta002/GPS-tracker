const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'YOUR_SECRET_API_KEY';

// Enable CORS for all routes so external frontends or local file tests can access it
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key']
}));

app.use(express.json());

// In-memory storage for GPS data
let latestLocation = null;
const locationHistory = [];
const MAX_HISTORY = 500;

// Last time the ESP8266 talked to us (heartbeat or fix), and whether it had a fix
const deviceStatus = { lastSeen: null, hasFix: false, satellites: 0 };

// Connected SSE clients for real-time live streaming
const clients = new Set();

// Broadcast event to all connected SSE clients
function broadcastSSE(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch (err) {
      console.error('Error writing to client SSE stream:', err.message);
      clients.delete(client);
    }
  }
}

const fs = require('fs');

// Serve React production build from dist if available, else fallback to frontend
const distPath = path.join(__dirname, '..', 'frontend', 'dist');
const rawFrontendPath = path.join(__dirname, '..', 'frontend');
const frontendPath = fs.existsSync(distPath) ? distPath : rawFrontendPath;
app.use(express.static(frontendPath));

// Health check endpoint (for Render uptime, liveness probes & cron keep-alive pings)
app.get(['/health', '/api/health'], (req, res) => {
  res.json({
    status: 'online',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    connectedClients: clients.size,
    hasLocation: !!latestLocation,
    device: deviceStatus
  });
});

// Middleware to check API key on IoT write endpoint
function verifyApiKey(req, res, next) {
  // If API_KEY environment variable is set to empty or default, we can still allow or warn
  const clientKey = req.headers['x-api-key'];
  if (API_KEY && API_KEY !== 'YOUR_SECRET_API_KEY') {
    if (clientKey !== API_KEY) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or missing x-api-key header'
      });
    }
  }
  next();
}

/**
 * POST /api/location
 * Receives GPS coordinates from ESP8266
 * Body: { latitude, longitude, speed, satellites, altitude }
 */
app.post('/api/location', verifyApiKey, (req, res) => {
  const { latitude, longitude, speed = 0, satellites = 0, altitude = 0 } = req.body;

  if (latitude === undefined || longitude === undefined || isNaN(latitude) || isNaN(longitude)) {
    return res.status(400).json({
      error: 'Invalid coordinates',
      message: 'latitude and longitude are required numbers'
    });
  }

  const point = {
    latitude: Number(latitude),
    longitude: Number(longitude),
    speed: Number(speed),
    satellites: Number(satellites),
    altitude: Number(altitude),
    timestamp: new Date().toISOString()
  };

  latestLocation = point;
  locationHistory.push(point);
  Object.assign(deviceStatus, { lastSeen: point.timestamp, hasFix: true, satellites: point.satellites });
  broadcastSSE('device', deviceStatus);

  // Keep history bounded
  if (locationHistory.length > MAX_HISTORY) {
    locationHistory.shift();
  }

  console.log(`[GPS UPDATE] Lat: ${point.latitude.toFixed(6)}, Lng: ${point.longitude.toFixed(6)} | Spd: ${point.speed} km/h | Sats: ${point.satellites} | Time: ${point.timestamp}`);

  // Push immediate update to all live dashboards via SSE
  broadcastSSE('location', point);

  return res.status(200).json({
    success: true,
    message: 'Location updated successfully',
    data: point
  });
});

/**
 * POST /api/heartbeat
 * ESP8266 is online but has no GPS fix yet
 * Body: { satellites }
 */
app.post('/api/heartbeat', verifyApiKey, (req, res) => {
  const satellites = Number(req.body?.satellites) || 0;
  Object.assign(deviceStatus, { lastSeen: new Date().toISOString(), hasFix: false, satellites });
  broadcastSSE('device', deviceStatus);
  res.json({ success: true, device: deviceStatus });
});

/**
 * GET /api/location
 * Returns the current location and recent route history
 */
app.get('/api/location', (req, res) => {
  res.json({
    success: true,
    latest: latestLocation,
    device: deviceStatus,
    history: locationHistory,
    totalPoints: locationHistory.length
  });
});

/**
 * GET /api/location/stream
 * Server-Sent Events (SSE) for low-latency live location updates in the browser
 */
app.get('/api/location/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Send an immediate initial handshake
  res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', clients: clients.size + 1 })}\n\n`);

  res.write(`event: device
data: ${JSON.stringify(deviceStatus)}

`);

  // If there's an existing latest location, send it right away
  if (latestLocation) {
    res.write(`event: location\ndata: ${JSON.stringify(latestLocation)}\n\n`);
  }

  clients.add(res);
  console.log(`[SSE] Client connected. Total active listeners: ${clients.size}`);

  // Heartbeat ping every 25 seconds to keep Render / proxy connection alive
  const pingInterval = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(pingInterval);
    clients.delete(res);
    console.log(`[SSE] Client disconnected. Active listeners: ${clients.size}`);
  });
});

/**
 * DELETE /api/location/history
 * Clears the path history
 */
app.delete('/api/location/history', (req, res) => {
  locationHistory.length = 0;
  broadcastSSE('history_cleared', { clearedAt: new Date().toISOString() });
  res.json({ success: true, message: 'Location history cleared' });
});

/**
 * POST /api/simulate
 * Simulates a GPS point (useful for testing frontend before hardware is ready)
 */
app.post('/api/simulate', (req, res) => {
  // If no coordinates provided, generate slight movement from last or default to a realistic location (e.g. New Delhi India Gate 28.6129, 77.2295)
  const baseLat = latestLocation ? latestLocation.latitude : 28.6129;
  const baseLng = latestLocation ? latestLocation.longitude : 77.2295;

  const latOffset = (Math.random() - 0.45) * 0.001;
  const lngOffset = (Math.random() - 0.45) * 0.001;

  const simulatedPoint = {
    latitude: Number((baseLat + latOffset).toFixed(6)),
    longitude: Number((baseLng + lngOffset).toFixed(6)),
    speed: Number((Math.random() * 35 + 5).toFixed(1)),
    satellites: Math.floor(Math.random() * 4) + 8,
    altitude: Number((210 + Math.random() * 10).toFixed(1)),
    timestamp: new Date().toISOString(),
    isSimulated: true
  };

  latestLocation = simulatedPoint;
  locationHistory.push(simulatedPoint);
  if (locationHistory.length > MAX_HISTORY) locationHistory.shift();
  Object.assign(deviceStatus, { lastSeen: simulatedPoint.timestamp, hasFix: true, satellites: simulatedPoint.satellites });
  broadcastSSE('device', deviceStatus);

  broadcastSSE('location', simulatedPoint);

  res.json({ success: true, simulated: simulatedPoint });
});

// Fallback to index.html for client-side routing
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🚀 GPS Tracker Backend Server running on port ${PORT}`);
  console.log(`📡 Web Dashboard: http://localhost:${PORT}`);
  console.log(`📍 Location Endpoint: POST http://localhost:${PORT}/api/location`);
  console.log(`🔄 SSE Live Stream: GET http://localhost:${PORT}/api/location/stream`);
  console.log(`===============================================`);
});
