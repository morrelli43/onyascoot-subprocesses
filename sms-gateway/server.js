const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4330;
const API_KEY = process.env.SMS_GATEWAY_API_KEY;
const OPS_API_KEY = process.env.OPS_API_KEY;
const WEB_PORTAL_INCOMING_URL = process.env.WEB_PORTAL_INCOMING_URL;

// Phone's local HTTP API (the NanoHTTPD server running on the handset)
// Can be set via env var; otherwise discovered from the WebSocket peer address on connect
const PHONE_API_URL = process.env.PHONE_API_URL || null;
let discoveredPhoneApiUrl = null; // Set when device connects

if (!API_KEY) {
  console.error('❌ SMS_GATEWAY_API_KEY is not defined in environment variables');
  process.exit(1);
}

// Map to store active WebSocket connections by Device ID
const devices = new Map();

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

/**
 * WebSocket Authentication and Handshake
 */
server.on('upgrade', (request, socket, head) => {
  const urlParams = new URL(request.url, `http://${request.headers.host}`).searchParams;
  
  const authHeader = request.headers['authorization'];
  const headerApiKey = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  const headerDeviceId = request.headers['x-device-id'];

  const queryApiKey = urlParams.get('apiKey');
  const queryDeviceId = urlParams.get('deviceId');

  const apiKey = queryApiKey || headerApiKey;
  const deviceId = queryDeviceId || headerDeviceId;

  console.log(`📡 WS Upgrade: ${request.url}`);
  console.log(`   - Extracted API Key (first 4): ${apiKey ? apiKey.substring(0, 4) + '...' : 'MISSING'}`);
  console.log(`   - Extracted Device ID: ${deviceId || 'MISSING'}`);

  if (!apiKey || apiKey !== API_KEY) {
    console.log(`❌ Auth check failed. (Expected vs Actual mask match: ${apiKey === API_KEY})`);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  if (!deviceId) {
    console.log(`❌ Device ID check failed. (MISSING)`);
    socket.write('HTTP/1.1 400 Bad Request: Missing Device ID\r\n\r\n');
    socket.destroy();
    return;
  }

  console.log(`✅ Handshake successful for ${deviceId}`);

  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.deviceId = deviceId;
    ws.isAlive = true;
    devices.set(deviceId, ws);
    console.log(`✅ Device connected: ${deviceId}`);

    // Discover phone's HTTP API URL from headers the Android app sends on connect
    const headerLocalIp   = request.headers['x-local-ip'];
    const headerLocalPort = request.headers['x-local-port'] || '4330';
    if (PHONE_API_URL) {
      discoveredPhoneApiUrl = PHONE_API_URL;
      console.log(`📱 Using configured phone API URL: ${discoveredPhoneApiUrl}`);
    } else if (headerLocalIp && headerLocalIp !== '0.0.0.0') {
      discoveredPhoneApiUrl = `http://${headerLocalIp}:${headerLocalPort}`;
      console.log(`📱 Discovered phone HTTP API from headers: ${discoveredPhoneApiUrl}`);
    } else {
      console.warn(`⚠️ Could not determine phone local IP (header was: ${headerLocalIp}). Set PHONE_API_URL env var as fallback.`);
    }

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        console.log(`📩 Message from device ${deviceId}:`, data);

        // Force the URL directly to the Operations App on the docker internal network
        const targetUrl = 'http://onya-operations-live-app:3000/api/webhooks/sms';
        try {
          // Map device payload to Onyascoot Operations format, but preserve everything!
          // This prevents complete rejection if the Android app schema changes.
          const forwardData = {
            address: data.from || data.address || data.sender,
            body: data.text || data.body || data.message || data.snippet,
            direction: 'inbound',
            ...data
          };

          const headers = { 'Content-Type': 'application/json' };

          // Use OPS_API_KEY if available for Bearer authentication
          if (OPS_API_KEY) {
            headers['Authorization'] = `Bearer ${OPS_API_KEY}`;
          }

          try {
            await axios.post(targetUrl, forwardData, { headers, timeout: 5000 });
            console.log(`🚀 Forwarded inbound SMS to internal router: ${targetUrl}`);
          } catch(firstErr) {
            console.error(`⚠️ Internal DNS failed (${targetUrl}), trying public interface: 172.17.43.12:3010: ${firstErr.message}`);
            // Let's try the direct public-exposed Docker interface as an absolute foolproof fallback!
            await axios.post('http://172.17.43.12:3010/api/webhooks/sms', forwardData, { headers, timeout: 5000 });
            console.log(`🚀 Forwarded inbound SMS to external interface: http://172.17.43.12:3010/api/webhooks/sms`);
          }
        } catch (err) {
          console.error(`❌ Error forwarding inbound SMS: ${err.message}`);
        }

      } catch (err) {
        console.error(`❌ Error parsing message from device ${deviceId}:`, err.message);
      }
    });

    ws.on('close', () => {
      devices.delete(deviceId);
      console.log(`❌ Device disconnected: ${deviceId}`);
    });
  });
});

/**
 * Relay Endpoint: Web Portal -> Phone
 */
app.post('/api/send-sms', (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { deviceId, address, body, mediaUrl } = req.body;

  if (!deviceId || !address || !body) {
    return res.status(400).json({ error: 'Missing deviceId, address, or body' });
  }

  const ws = devices.get(deviceId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ error: `Device ${deviceId} is not connected` });
  }

  // Support both SMS and MMS actions
  const action = mediaUrl ? 'send_mms' : 'send_sms';
  const payload = {
    action,
    data: { 
      address, 
      body,
      ...(mediaUrl && { mediaUrl })
    }
  };

  try {
    ws.send(JSON.stringify(payload));
    console.log(`📤 Relay signal (${action}) sent to device ${deviceId}:`, payload);
    res.json({ status: 'sent', action, deviceId });
  } catch (err) {
    console.error(`❌ Error sending to device ${deviceId}:`, err.message);
    res.status(500).json({ error: 'Failed to relay message to device' });
  }
});

/**
 * Proxy: GET /api/conversations -> Phone HTTP API
 * Allows the Operations Dashboard to retrieve all SMS threads from the phone.
 */
app.get('/api/conversations', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const phoneUrl = discoveredPhoneApiUrl || PHONE_API_URL;
  if (!phoneUrl) {
    return res.status(503).json({ error: 'Phone not connected or PHONE_API_URL not set' });
  }

  try {
    console.log(`📲 Proxying GET /api/conversations -> ${phoneUrl}`);
    const response = await axios.get(`${phoneUrl}/api/conversations`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
      timeout: 10000
    });
    res.json(response.data);
  } catch (err) {
    console.error(`❌ Failed to proxy conversations: ${err.message}`);
    res.status(502).json({ error: 'Failed to reach phone HTTP API', details: err.message });
  }
});

/**
 * Proxy: GET /api/messages -> Phone HTTP API
 * Forwards threadId, limit, offset, includeMms query params.
 */
app.get('/api/messages', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const phoneUrl = discoveredPhoneApiUrl || PHONE_API_URL;
  if (!phoneUrl) {
    return res.status(503).json({ error: 'Phone not connected or PHONE_API_URL not set' });
  }

  const query = new URLSearchParams(req.query).toString();
  try {
    console.log(`📲 Proxying GET /api/messages?${query} -> ${phoneUrl}`);
    const response = await axios.get(`${phoneUrl}/api/messages?${query}`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
      timeout: 15000
    });
    res.json(response.data);
  } catch (err) {
    console.error(`❌ Failed to proxy messages: ${err.message}`);
    res.status(502).json({ error: 'Failed to reach phone HTTP API', details: err.message });
  }
});

/**
 * Health Check
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    connections: devices.size,
    activeDevices: Array.from(devices.keys())
  });
});

/**
 * Heartbeat: Keep connections alive
 */
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log(`⚠️ Terminating inactive connection: ${ws.deviceId}`);
      devices.delete(ws.deviceId);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SMS Relay Server listening on port ${PORT}`);
});
