# 🛰️ GeoPulse | Real-Time IoT GPS Tracker & Live Dashboard

An end-to-end IoT GPS tracking system using an **ESP8266 (NodeMCU)**, a **u-blox Neo-6M GPS module**, a high-performance **Node.js/Express Backend** (deployable to Render), and a **Modern White-Theme Real-Time Web Dashboard** powered by Leaflet.js and Server-Sent Events (SSE).

---

## 📁 Project Structure

```text
GPS tracker/
├── backend/
│   ├── server.js            # Express API + SSE Live Stream + Static Frontend Hosting
│   ├── package.json         # Node.js dependencies (express, cors, dotenv)
│   ├── .env.example         # Environment variables template
│   ├── .env                 # Local environment configuration
│   └── render.yaml          # 1-Click Render deployment blueprint
├── frontend/
│   ├── index.html           # Modern White-Theme Live Dashboard
│   ├── style.css            # Clean, aesthetic light styling & animations
│   └── app.js               # Leaflet map, SSE stream receiver & telemetry updates
├── firmware/
│   └── gps_tracker_esp8266.ino # Arduino sketch for NodeMCU + Neo-6M GPS
└── README.md                # Comprehensive documentation
```

---

## ⚡ Hardware Wiring Diagram

Connect your **Neo-6M GPS Module** to the **ESP8266 NodeMCU** as follows:

| Neo-6M GPS Pin | NodeMCU (ESP8266) Pin | Notes |
| :--- | :--- | :--- |
| **VCC** | **3.3V** or **VIN / 5V** | Neo-6M modules usually have an onboard 3.3V LDO regulator |
| **GND** | **GND** | Common ground |
| **TX** | **D1** (GPIO 5) | SoftwareSerial RX (Receives NMEA sentences from GPS) |
| **RX** | **D2** (GPIO 4) | SoftwareSerial TX (Sends commands to GPS) |

> 💡 **Important Tip for GPS Fix:**
> - When testing indoors, GPS modules usually cannot acquire satellite lock due to roof/walls blocking RF signals.
> - Take the antenna near a window or outdoors under an open sky.
> - The **green/red LED** on the Neo-6M module will start **blinking** once a valid satellite fix is locked!

---

## 🖥️ Serial Monitor Output (115200 Baud)

When running, the ESP8266 prints formatted telemetry directly to the Serial Monitor:

```text
==================================================
📍 [LIVE GPS FIX ACQUIRED]
 Latitude    : 28.613939
 Longitude   : 77.209021
 Speed       : 18.50 km/h
 Satellites  : 9
 Altitude    : 215.4 meters
 Google Maps : https://maps.google.com/?q=28.613939,77.209021
==================================================
Sending POST request to: https://your-gps-server.onrender.com/api/location
Server HTTP Response Code: 200
Response: {"success":true,"message":"Location updated successfully"}
```

---

## ☁️ Deploy Backend to Render (Step-by-Step)

The backend is built so that **a single Render URL** serves both:
1. The **Live Web Dashboard** when opened in a browser (`https://your-service.onrender.com/`)
2. The **IoT API Endpoint** where the ESP8266 sends coordinates (`https://your-service.onrender.com/api/location`)

### Steps:
1. Push this project to your GitHub repository.
2. Go to [Render.com](https://render.com) and click **New +** -> **Web Service**.
3. Connect your GitHub repository.
4. Set the following settings:
   - **Name**: `my-gps-tracker` (or any name you choose)
   - **Root Directory**: `backend`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free`
5. Under **Environment Variables**, add:
   - `API_KEY` = `YOUR_SECRET_API_KEY` (or your chosen secret password)
6. Click **Create Web Service**.
7. Once deployed, Render will provide a public URL like:
   `https://my-gps-tracker.onrender.com`
8. In [`gps_tracker_esp8266.ino`](firmware/gps_tracker_esp8266.ino), update `SERVER_URL`:
   ```cpp
   const char* SERVER_URL = "https://my-gps-tracker.onrender.com/api/location";
   const char* API_KEY    = "YOUR_SECRET_API_KEY";
   ```

---

## 💻 Local Testing & Development

You can test the entire system on your computer right away:

### 1. Start the Backend Server:
```bash
cd backend
npm install
npm start
```
Server runs at `http://localhost:3000`.

### 2. Open the Dashboard:
Open `http://localhost:3000` in any browser.

### 3. Test Without Hardware ("Simulate Ping"):
Click the **"Simulate Ping"** button on the top right of the dashboard. It will generate a simulated GPS reading, update the coordinates, move the map beacon, draw the path line, and calculate traveled distance!

---

## 🌐 API Reference

### 1. Update Location (Used by ESP8266)
- **Method**: `POST`
- **URL**: `/api/location`
- **Headers**:
  - `Content-Type: application/json`
  - `x-api-key: YOUR_SECRET_API_KEY`
- **Body**:
  ```json
  {
    "latitude": 28.613939,
    "longitude": 77.209021,
    "speed": 18.5,
    "satellites": 9,
    "altitude": 215.4
  }
  ```

### 2. Fetch Latest Location & Path History
- **Method**: `GET`
- **URL**: `/api/location`

### 3. Real-Time Server-Sent Events (SSE) Stream
- **Method**: `GET`
- **URL**: `/api/location/stream`

### 4. Clear Route History
- **Method**: `DELETE`
- **URL**: `/api/location/history`
