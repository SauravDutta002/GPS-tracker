/*
 ==============================================================================
  GeoPulse: ESP8266 NodeMCU + Neo-6M GPS Tracker Firmware
 ==============================================================================
  Hardware Connections:
  - GPS Module VCC  -> NodeMCU 3.3V (or 5V/VIN if 5V module)
  - GPS Module GND  -> NodeMCU GND
  - GPS Module TX   -> NodeMCU D1 (GPIO 5) [SoftwareSerial RX]
  - GPS Module RX   -> NodeMCU D2 (GPIO 4) [SoftwareSerial TX]

  Required Arduino IDE Libraries:
  - TinyGPSPlus by Mikal Hart (Install via Library Manager)
  - ESP8266WiFi & ESP8266HTTPClient (Built into ESP8266 Board Package)
 ==============================================================================
*/

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>
#include <SoftwareSerial.h>
#include <TinyGPSPlus.h>

// ================= WIFI CONFIGURATION =================
// Configured with your WiFi credentials:
const char* WIFI_SSID     = "IOT";            // Change if your WiFi name/hotspot is different
const char* WIFI_PASSWORD = "123456789";      // Note: If your password literally includes 'IOT ', change to "IOT 123456789"

// ================= RENDER BACKEND CONFIGURATION =================
// Your deployed Render backend URL:
const char* SERVER_URL    = "https://gps-tracker-m6wx.onrender.com/api/location";

// Must match the API_KEY set in your backend environment
const char* API_KEY       = "YOUR_SECRET_API_KEY";

// ================= PIN DEFINITIONS =================
// GPS TX connects to NodeMCU D1 (GPIO 5)
// GPS RX connects to NodeMCU D2 (GPIO 4)
static const int RXPin = D1;
static const int TXPin = D2;
static const uint32_t GPSBaud = 9600;

SoftwareSerial gpsSerial(RXPin, TXPin);
TinyGPSPlus gps;

// Timing interval (sends coordinate every 5 seconds)
unsigned long lastSendTime = 0;
const unsigned long SEND_INTERVAL = 5000;

// Diagnostics counters
unsigned long lastDiagTime = 0;

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.println();
  Serial.print("Connecting to WiFi: ");
  Serial.println(WIFI_SSID);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("==================================================");
    Serial.println(" WiFi Connected Successfully!");
    Serial.print(" IP Address: ");
    Serial.println(WiFi.localIP());
    Serial.print(" Signal Strength (RSSI): ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
    Serial.println("==================================================");
  } else {
    Serial.println("⚠️ WiFi connection failed! Will keep retrying in background...");
  }
}

void printCoordinatesToSerial(double lat, double lng, double speedKmph, int sats, double altMeters) {
  Serial.println();
  Serial.println("==================================================");
  Serial.println("📍 [LIVE GPS FIX ACQUIRED]");
  Serial.print(" Latitude    : ");
  Serial.println(lat, 6);
  Serial.print(" Longitude   : ");
  Serial.println(lng, 6);
  Serial.print(" Speed       : ");
  Serial.print(speedKmph, 2);
  Serial.println(" km/h");
  Serial.print(" Satellites  : ");
  Serial.println(sats);
  Serial.print(" Altitude    : ");
  Serial.print(altMeters, 1);
  Serial.println(" meters");
  Serial.print(" Google Maps : https://maps.google.com/?q=");
  Serial.print(lat, 6);
  Serial.print(",");
  Serial.println(lng, 6);
  Serial.println("==================================================");
}

void sendGPSLocation() {
  // Check WiFi connection
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("⚠️ WiFi disconnected. Attempting reconnect...");
    WiFi.reconnect();
    return;
  }

  // Check if GPS module has a valid satellite fix
  if (!gps.location.isValid()) {
    int sats = gps.satellites.isValid() ? gps.satellites.value() : 0;
    Serial.print("⏳ Waiting for valid GPS fix... (Visible Satellites: ");
    Serial.print(sats);
    Serial.print(", Chars decoded: ");
    Serial.print(gps.charsProcessed());
    Serial.println(")");
    return;
  }

  double latitude  = gps.location.lat();
  double longitude = gps.location.lng();
  double speedKmph = gps.speed.isValid() ? gps.speed.kmph() : 0.0;
  int satellites   = gps.satellites.isValid() ? gps.satellites.value() : 0;
  double altitude  = gps.altitude.isValid() ? gps.altitude.meters() : 0.0;

  // Print nicely formatted coordinates directly to Serial Monitor
  printCoordinatesToSerial(latitude, longitude, speedKmph, satellites, altitude);

  // Send coordinates to Render backend over HTTPS
  WiFiClientSecure client;
  client.setInsecure(); // Allows HTTPS without loading SSL root certificates on ESP8266

  HTTPClient http;

  Serial.print("Sending POST request to: ");
  Serial.println(SERVER_URL);

  if (!http.begin(client, SERVER_URL)) {
    Serial.println("❌ Could not initialize HTTP connection to server");
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", API_KEY);

  // Construct JSON payload
  String payload = "{";
  payload += "\"latitude\":" + String(latitude, 6) + ",";
  payload += "\"longitude\":" + String(longitude, 6) + ",";
  payload += "\"speed\":" + String(speedKmph, 2) + ",";
  payload += "\"satellites\":" + String(satellites) + ",";
  payload += "\"altitude\":" + String(altitude, 1);
  payload += "}";

  int httpCode = http.POST(payload);

  Serial.print("Server HTTP Response Code: ");
  Serial.println(httpCode);

  if (httpCode > 0) {
    String responseBody = http.getString();
    Serial.print("Response: ");
    Serial.println(responseBody);
  } else {
    Serial.print("❌ Request failed! Error: ");
    Serial.println(http.errorToString(httpCode));
  }

  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println("**************************************************");
  Serial.println("       GeoPulse ESP8266 GPS Tracker Starting      ");
  Serial.println("**************************************************");

  // Start GPS SoftwareSerial communication
  gpsSerial.begin(GPSBaud);
  Serial.print("Listening to GPS module on D1 (RX) / D2 (TX) at ");
  Serial.print(GPSBaud);
  Serial.println(" baud...");

  connectWiFi();
}

void loop() {
  // Continuously feed incoming NMEA sentences from GPS to TinyGPSPlus
  while (gpsSerial.available() > 0) {
    char c = gpsSerial.read();
    gps.encode(c);
  }

  // Periodic location dispatch
  if (millis() - lastSendTime >= SEND_INTERVAL) {
    lastSendTime = millis();
    sendGPSLocation();
  }

  // Hardware Diagnostic check every 15 seconds
  if (millis() - lastDiagTime >= 15000) {
    lastDiagTime = millis();
    if (gps.charsProcessed() < 10) {
      Serial.println("⚠️ DIAGNOSTIC: No GPS data received! Check wiring:");
      Serial.println("   - GPS Module TX  -> NodeMCU D1 (GPIO5)");
      Serial.println("   - GPS Module RX  -> NodeMCU D2 (GPIO4)");
      Serial.println("   - GPS Module VCC -> 3.3V / 5V");
      Serial.println("   - GPS Module GND -> GND");
    }
  }

  // Auto-reconnect WiFi if connection drops
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
  }
}
