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

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        console.log(`📩 Message from device ${deviceId}:`, data);

        // Always attempt to forward the notification
        const targetUrl = WEB_PORTAL_INCOMING_URL || 'http://onya-operations-live-app:3000/api/webhooks/sms';
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

          await axios.post(targetUrl, forwardData, { headers, timeout: 5000 });
          console.log(`🚀 Forwarded inbound SMS to web portal: ${targetUrl}`);
        } catch (err) {
          console.error(`❌ Error forwarding to web portal (${targetUrl}): ${err.message}`);
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
