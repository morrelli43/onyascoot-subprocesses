const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4330;
const API_KEY = process.env.SMS_GATEWAY_API_KEY;
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
  const authHeader = request.headers['authorization'];
  const deviceId = request.headers['x-device-id'];

  if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== API_KEY) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  if (!deviceId) {
    socket.write('HTTP/1.1 400 Bad Request: Missing X-Device-ID\r\n\r\n');
    socket.destroy();
    return;
  }

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

        // Forward and log notification if configured
        if (WEB_PORTAL_INCOMING_URL) {
          try {
            await axios.post(WEB_PORTAL_INCOMING_URL, {
              deviceId,
              payload: data
            });
            console.log(`🚀 Forwarded to web portal: ${WEB_PORTAL_INCOMING_URL}`);
          } catch (err) {
            console.error(`❌ Error forwarding to web portal: ${err.message}`);
          }
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
  const { deviceId, address, body } = req.body;

  if (!deviceId || !address || !body) {
    return res.status(400).json({ error: 'Missing deviceId, address, or body' });
  }

  const ws = devices.get(deviceId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ error: `Device ${deviceId} is not connected` });
  }

  const payload = {
    action: 'send_sms',
    data: { address, body }
  };

  try {
    ws.send(JSON.stringify(payload));
    console.log(`📤 Relay signal sent to device ${deviceId}:`, payload);
    res.json({ status: 'sent', deviceId });
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
