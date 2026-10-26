// Backend connection is fixed here so the dashboard works out of the box.
// Local dev (vite on :5173) talks to the local backend instead.
const isLocalDev = typeof window !== 'undefined' && window.location.port === '5173';

export const BACKEND_URL = isLocalDev
  ? 'http://localhost:3000'
  : 'https://gps-tracker-m6wx.onrender.com';

export const API_KEY = 'YOUR_SECRET_API_KEY';
