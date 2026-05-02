const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { saveMessage, getMessages, getConversations, mediaDir } = require('./db');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/media', express.static(mediaDir));

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

        // --- DATABASE STORAGE ---
        const messageId = data.id || `msg-${uuidv4().slice(0, 8)}`;
        let mediaPath = null;
        let mimeType = null;

        // Handle MMS data
        if (data.media && Array.isArray(data.media) && data.media.length > 0) {
          const part = data.media[0];
          if (part.dataBase64) {
            mimeType = part.mimeType || 'image/jpeg';
            const ext = mimeType.split('/')[1] || 'jpg';
            const fileName = `${messageId}.${ext}`;
            const fullPath = path.join(mediaDir, fileName);
            fs.writeFileSync(fullPath, Buffer.from(part.dataBase64, 'base64'));
            mediaPath = fileName;
            console.log(`🖼️ Saved MMS image: ${fileName}`);
          }
        } else if (data.attachmentBase64) {
          mimeType = 'image/jpeg'; // Default for legacy
          const fileName = `${messageId}.jpg`;
          const fullPath = path.join(mediaDir, fileName);
          fs.writeFileSync(fullPath, Buffer.from(data.attachmentBase64, 'base64'));
          mediaPath = fileName;
          console.log(`🖼️ Saved MMS image (legacy): ${fileName}`);
        }

        const address = data.from || data.address || data.sender;
        const body = data.text || data.body || data.message || data.snippet;
        const threadId = data.threadId || data.thread_id;

        saveMessage({
          id: messageId,
          deviceId,
          address,
          body,
          direction: 'inbound',
          mediaPath,
          mimeType,
          timestamp: data.timestamp ? new Date(data.timestamp).toISOString() : new Date().toISOString(),
          threadId,
          status: 'received'
        });

        // Force the URL directly to the Operations App on the docker internal network
        const targetUrl = 'http://onya-operations-live-app:3000/api/webhooks/sms';
        try {
          // Map device payload to Onyascoot Operations format
          const forwardData = {
            address: address,
            body: body,
            direction: 'inbound',
            message_uid: messageId,
            threadId: threadId,
            mediaUrl: mediaPath ? `/media/${mediaPath}` : null,
            ...data
          };

          const headers = { 'Content-Type': 'application/json' };

          if (OPS_API_KEY) {
            headers['Authorization'] = `Bearer ${OPS_API_KEY}`;
          }

          try {
            await axios.post(targetUrl, forwardData, { headers, timeout: 5000 });
            console.log(`🚀 Forwarded inbound SMS to internal router: ${targetUrl}`);
          } catch(firstErr) {
            console.error(`⚠️ Internal DNS failed (${targetUrl}), trying public interface: 172.17.43.12:3010: ${firstErr.message}`);
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
    
    // Save outbound message to local DB
    const messageId = `msg-out-${uuidv4().slice(0, 8)}`;
    saveMessage({
      id: messageId,
      deviceId,
      address,
      body,
      direction: 'outbound',
      timestamp: new Date().toISOString(),
      status: 'pending'
    });

    res.json({ status: 'sent', action, deviceId, message_uid: messageId });
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

  // First, check local database
  const localConversations = getConversations();
  if (localConversations.length > 0 && req.query.sync !== 'true') {
    console.log(`📦 Serving ${localConversations.length} conversations from local DB`);
    return res.json(localConversations.map(c => ({
      address: c.address,
      snippet: c.last_message_body,
      date: new Date(c.last_message_timestamp).getTime(),
      threadId: c.thread_id
    })));
  }

  const phoneUrl = discoveredPhoneApiUrl || PHONE_API_URL;
  if (!phoneUrl) {
    // If phone not connected, return whatever we have in local DB
    return res.json(localConversations);
  }

  try {
    console.log(`📲 Proxying GET /api/conversations -> ${phoneUrl} (Syncing)`);
    const response = await axios.get(`${phoneUrl}/api/conversations`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
      timeout: 10000
    });

    // Background: update local DB with fresh data
    response.data.forEach(conv => {
      // Create a dummy message to trigger conversation upsert
      saveMessage({
        id: `sync-conv-${conv.threadId || conv.id}`,
        deviceId: 'sync',
        address: conv.address,
        body: conv.snippet || conv.body || '',
        direction: 'inbound',
        timestamp: conv.date ? new Date(conv.date).toISOString() : new Date().toISOString(),
        threadId: conv.threadId || conv.id,
        status: 'synced'
      });
    });

    res.json(response.data);
  } catch (err) {
    console.error(`❌ Failed to proxy conversations: ${err.message}`);
    // Fallback to local DB if proxy fails
    res.json(localConversations);
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

  const { address, threadId, limit, offset, sync } = req.query;

  // First, check local database
  const localMessages = getMessages({ address, threadId, limit: parseInt(limit) || 50, offset: parseInt(offset) || 0 });
  if (localMessages.length > 0 && sync !== 'true') {
    console.log(`📦 Serving ${localMessages.length} messages from local DB`);
    return res.json(localMessages.map(m => ({
      id: m.id,
      address: m.address,
      body: m.body,
      type: m.direction === 'inbound' ? 1 : 2,
      date: new Date(m.timestamp).getTime(),
      threadId: m.thread_id,
      mediaUrl: m.media_path ? `/media/${m.media_path}` : null,
      attachmentBase64: null // We serve via mediaUrl now
    })));
  }

  const phoneUrl = discoveredPhoneApiUrl || PHONE_API_URL;
  if (!phoneUrl) {
    return res.json(localMessages);
  }

  const query = new URLSearchParams(req.query).toString();
  try {
    console.log(`📲 Proxying GET /api/messages?${query} -> ${phoneUrl} (Syncing)`);
    const response = await axios.get(`${phoneUrl}/api/messages?${query}`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
      timeout: 15000
    });

    // Background: update local DB with fresh data
    if (Array.isArray(response.data)) {
      response.data.forEach(pm => {
        saveMessage({
          id: pm.id || `sync-msg-${uuidv4().slice(0, 8)}`,
          deviceId: 'sync',
          address: pm.address || address,
          body: pm.body || '',
          direction: pm.type === 1 ? 'inbound' : 'outbound',
          timestamp: pm.date ? new Date(pm.date).toISOString() : new Date().toISOString(),
          threadId: pm.threadId || threadId,
          status: 'synced'
        });
      });
    }

    res.json(response.data);
  } catch (err) {
    console.error(`❌ Failed to proxy messages: ${err.message}`);
    res.json(localMessages);
  }
});

/**
 * Full Sync: Pulls every conversation and message from the phone.
 */
async function syncAllFromPhone() {
  const phoneUrl = discoveredPhoneApiUrl || PHONE_API_URL;
  if (!phoneUrl) {
    console.error('❌ Cannot sync: Phone not connected');
    return { error: 'Phone not connected' };
  }

  console.log('🔄 Starting Full Sync from phone...');
  try {
    const convRes = await axios.get(`${phoneUrl}/api/conversations`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
      timeout: 20000
    });

    const conversations = convRes.data;
    console.log(`📑 Found ${conversations.length} conversations. Syncing messages...`);

    let totalMessages = 0;
    for (const conv of conversations) {
      const threadId = conv.threadId || conv.id;
      const address = conv.address;
      
      try {
        const msgRes = await axios.get(`${phoneUrl}/api/messages?threadId=${threadId}&limit=1000&includeMms=true`, {
          headers: { 'Authorization': `Bearer ${API_KEY}` },
          timeout: 30000
        });

        const messages = msgRes.data;
        if (Array.isArray(messages)) {
          messages.forEach(pm => {
            const messageId = pm.id || `sync-${threadId}-${pm.date}`;
            
            // Handle MMS for sync too
            let mediaPath = null;
            if (pm.attachmentBase64) {
              const fileName = `${messageId}.jpg`;
              const fullPath = path.join(mediaDir, fileName);
              if (!fs.existsSync(fullPath)) {
                fs.writeFileSync(fullPath, Buffer.from(pm.attachmentBase64, 'base64'));
              }
              mediaPath = fileName;
            }

            saveMessage({
              id: messageId,
              deviceId: 'sync-full',
              address: pm.address || address,
              body: pm.body || '',
              direction: pm.type === 1 ? 'inbound' : 'outbound',
              timestamp: pm.date ? new Date(pm.date).toISOString() : new Date().toISOString(),
              threadId: threadId,
              mediaPath: mediaPath,
              status: 'synced'
            });
          });
          totalMessages += messages.length;
          console.log(`✅ Synced ${messages.length} messages for thread ${threadId} (${address})`);
        }
      } catch (err) {
        console.error(`⚠️ Failed to sync thread ${threadId}: ${err.message}`);
      }
    }

    console.log(`🏁 Full Sync Complete! Cached ${totalMessages} messages.`);
    return { status: 'complete', conversations: conversations.length, messages: totalMessages };
  } catch (err) {
    console.error(`❌ Full Sync failed: ${err.message}`);
    return { error: err.message };
  }
}

/**
 * Endpoint to trigger full sync
 */
app.post('/api/sync-all', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Run in background to avoid timeout
  syncAllFromPhone();
  res.json({ status: 'sync_started', message: 'Full sync initiated in background' });
});

/**
 * Health Check
 */
app.get('/health', (req, res) => {
  const isConnected = devices.size > 0;
  res.status(isConnected ? 200 : 503).json({ 
    status: isConnected ? 'ok' : 'error', 
    connections: devices.size,
    activeDevices: Array.from(devices.keys()),
    services: {
      phone_connection: isConnected ? 'ok' : 'error: no devices connected'
    }
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
