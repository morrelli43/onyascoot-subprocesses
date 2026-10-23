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

// Map to manage async request-response cycles over WebSocket
const pendingWsRequests = new Map();

function sendWsRequest(ws, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const requestId = uuidv4();
    const timer = setTimeout(() => {
      pendingWsRequests.delete(requestId);
      reject(new Error(`WebSocket request timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingWsRequests.set(requestId, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ ...payload, requestId }));
    } catch (err) {
      clearTimeout(timer);
      pendingWsRequests.delete(requestId);
      reject(err);
    }
  });
}

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
  const headerDeviceName = request.headers['x-device-name'];

  const queryApiKey = urlParams.get('apiKey');
  const queryDeviceId = urlParams.get('deviceId');
  const queryDeviceName = urlParams.get('deviceName');

  const apiKey = queryApiKey || headerApiKey;
  const deviceId = queryDeviceId || headerDeviceId;
  const deviceName = queryDeviceName || headerDeviceName;

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
    ws.deviceName = deviceName ? decodeURIComponent(deviceName) : null;
    ws.isAlive = true;

    // Terminate any existing connection for this device ID to prevent ghost sockets
    const existingWs = devices.get(deviceId);
    if (existingWs && existingWs !== ws) {
      console.log(`🔄 Superseding previous connection for ${deviceId}`);
      try {
        existingWs.terminate();
      } catch (e) {
        // ignore
      }
    }

    devices.set(deviceId, ws);
    console.log(`✅ Device connected: ${deviceId} ${ws.deviceName ? `("${ws.deviceName}")` : ''}`);

    // If deviceName was supplied in headers, automatically notify Operations webhook
    if (ws.deviceName) {
      const targetUrl = process.env.WEB_PORTAL_INCOMING_URL || 'http://172.17.43.13:3010/api/webhooks/sms';
      const regPayload = {
        event: 'device_registration',
        device_id: deviceId,
        device_name: ws.deviceName,
        timestamp: new Date().toISOString()
      };
      const headers = { 'Content-Type': 'application/json' };
      if (OPS_API_KEY) headers['Authorization'] = `Bearer ${OPS_API_KEY}`;
      axios.post(targetUrl, regPayload, { headers, timeout: 5000 }).catch(e => {
        console.warn(`⚠️ Failed to forward initial device_registration to ${targetUrl}: ${e.message}`);
      });
    }

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
        const raw = JSON.parse(message);
        console.log(`📩 Message from device ${deviceId}:`, raw.action || raw.event || 'message');

        // Check if this is a response to a pending request (fetch_conversations, fetch_messages)
        if (raw.action === 'fetch_conversations_response' || raw.action === 'fetch_messages_response') {
          const pending = pendingWsRequests.get(raw.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingWsRequests.delete(raw.requestId);
            pending.resolve(raw.data || []);
            return;
          }
        }

        // Handle device registration / friendly name updates from handset
        if (raw.action === 'device_register') {
          const devName = raw.deviceName || raw.device_name;
          if (devName) ws.deviceName = devName;
          console.log(`📱 Device registration received: ${deviceId} -> "${ws.deviceName || 'unnamed'}"`);
          const targetUrl = process.env.WEB_PORTAL_INCOMING_URL || 'http://172.17.43.13:3010/api/webhooks/sms';
          try {
            const regPayload = {
              event: 'device_registration',
              device_id: deviceId,
              device_name: ws.deviceName,
              timestamp: new Date().toISOString()
            };
            const headers = { 'Content-Type': 'application/json' };
            if (OPS_API_KEY) headers['Authorization'] = `Bearer ${OPS_API_KEY}`;
            await axios.post(targetUrl, regPayload, { headers, timeout: 5000 });
            console.log(`🚀 Forwarded device registration to Operations for ${deviceId} (${ws.deviceName})`);
          } catch (e) {
            console.error(`❌ Error forwarding device_registration: ${e.message}`);
          }
          return;
        }

        // --- DATABASE STORAGE & INBOUND PROCESSING ---
        // Support nested payloads: { event: "incoming_sms", data: { ... } } or flat payloads
        const inner = (raw.data && typeof raw.data === 'object') ? raw.data : raw;
        const messageId = raw.id || inner.id || `msg-${uuidv4().slice(0, 8)}`;
        let mediaPath = null;
        let mimeType = null;

        // Handle MMS data
        const mediaArray = inner.media || raw.media;
        const attachmentBase64 = inner.attachmentBase64 || raw.attachmentBase64;
        const attachmentMimeType = inner.attachmentMimeType || raw.attachmentMimeType;

        if (mediaArray && Array.isArray(mediaArray) && mediaArray.length > 0) {
          const part = mediaArray[0];
          if (part.dataBase64) {
            mimeType = part.mimeType || 'image/jpeg';
            const ext = mimeType.split('/')[1] || 'jpg';
            const fileName = `${messageId}.${ext}`;
            const fullPath = path.join(mediaDir, fileName);
            fs.writeFileSync(fullPath, Buffer.from(part.dataBase64, 'base64'));
            mediaPath = fileName;
            console.log(`🖼️ Saved MMS image: ${fileName}`);
          }
        } else if (attachmentBase64) {
          mimeType = attachmentMimeType || 'image/jpeg';
          const ext = mimeType.split('/')[1] || 'jpg';
          const fileName = `${messageId}.${ext}`;
          const fullPath = path.join(mediaDir, fileName);
          fs.writeFileSync(fullPath, Buffer.from(attachmentBase64, 'base64'));
          mediaPath = fileName;
          console.log(`🖼️ Saved MMS image (attachmentBase64): ${fileName}`);
        }

        const address = inner.address || inner.from || inner.sender || raw.address || raw.from || raw.sender;
        const body = inner.body || inner.text || inner.message || inner.snippet || raw.body || raw.text || '';
        const threadId = inner.threadId || inner.thread_id || raw.threadId || raw.thread_id;
        const rawTime = inner.timestamp || raw.timestamp;
        const timestamp = rawTime ? (typeof rawTime === 'number' ? new Date(rawTime).toISOString() : new Date(rawTime).toISOString()) : new Date().toISOString();

        if (address) {
          saveMessage({
            id: messageId,
            deviceId,
            address,
            body,
            direction: 'inbound',
            mediaPath,
            mimeType,
            timestamp,
            threadId,
            status: 'received'
          });

          // Forward directly to the Operations App webhook
          const targetUrl = process.env.WEB_PORTAL_INCOMING_URL || 'http://172.17.43.13:3010/api/webhooks/sms';
          try {
            const mediaUrl = mediaPath ? `/media/${mediaPath}` : null;
            // Map device payload to Onyascoot Operations format
            const forwardData = {
              address: address,
              body: body,
              direction: 'inbound',
              message_uid: messageId,
              threadId: threadId,
              deviceId: deviceId,
              deviceName: ws.deviceName || null,
              mediaUrl: mediaUrl,
              timestamp,
              ...raw,
              data: {
                ...(typeof raw.data === 'object' ? raw.data : {}),
                address,
                body,
                threadId,
                mediaUrl
              }
            };

            const headers = { 'Content-Type': 'application/json' };
            if (OPS_API_KEY) {
              headers['Authorization'] = `Bearer ${OPS_API_KEY}`;
            }

            try {
              await axios.post(targetUrl, forwardData, { headers, timeout: 5000 });
              console.log(`🚀 Forwarded inbound SMS to Operations: ${targetUrl}`);
            } catch(firstErr) {
              console.error(`⚠️ Failed to forward to ${targetUrl}: ${firstErr.message}, trying fallback https://portal.onyascoot.com/api/webhooks/sms`);
              await axios.post('https://portal.onyascoot.com/api/webhooks/sms', forwardData, { headers, timeout: 5000 });
              console.log(`🚀 Forwarded inbound SMS to external interface: https://portal.onyascoot.com/api/webhooks/sms`);
            }
          } catch (err) {
            console.error(`❌ Error forwarding inbound SMS: ${err.message}`);
          }
        }

      } catch (err) {
        console.error(`❌ Error parsing message from device ${deviceId}:`, err.message);
      }
    });

    ws.on('close', () => {
      if (devices.get(deviceId) === ws) {
        devices.delete(deviceId);
        console.log(`❌ Device disconnected: ${deviceId}`);
      } else {
        console.log(`ℹ️ Stale connection closed for ${deviceId} (superseded by newer connection)`);
      }
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

  const { deviceId, address, body, mediaUrl, action: reqAction } = req.body;

  if (!deviceId || !address || (!body && reqAction !== 'dial')) {
    return res.status(400).json({ error: 'Missing deviceId, address, or body' });
  }

  const ws = devices.get(deviceId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ error: `Device ${deviceId} is not connected` });
  }

  // Support both SMS and MMS actions, as well as custom actions (like 'dial')
  const action = req.body.action || (mediaUrl ? 'send_mms' : 'send_sms');
  const payload = {
    action,
    data: { 
      address, 
      body,
      ...(mediaUrl && { mediaUrl }),
      ...(req.body.data || {}) // Merge any additional data
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
/**
 * GET /api/conversations
 * Retrieves all SMS threads from the phone via WebSocket first, then HTTP fallback, or local DB.
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

  // 1. Try active WebSocket client first (works over cellular NAT and Wi-Fi)
  const activeWs = Array.from(devices.values()).find(ws => ws.readyState === WebSocket.OPEN);
  if (activeWs) {
    try {
      console.log(`📲 Querying /api/conversations from device ${activeWs.deviceId} via WebSocket`);
      const convs = await sendWsRequest(activeWs, { action: 'fetch_conversations' }, 25000);
      if (Array.isArray(convs) && convs.length > 0) {
        convs.forEach(conv => {
          saveMessage({
            id: `sync-conv-${conv.threadId || conv.id}`,
            deviceId: activeWs.deviceId || 'sync',
            address: conv.address,
            body: conv.snippet || conv.body || '',
            direction: 'inbound',
            timestamp: conv.date ? new Date(conv.date).toISOString() : new Date().toISOString(),
            threadId: conv.threadId || conv.id,
            status: 'synced'
          });
        });
        return res.json(convs);
      }
    } catch (wsErr) {
      console.warn(`⚠️ WebSocket conversations query failed: ${wsErr.message}`);
    }
  }

  // 2. Fallback to HTTP proxy if phone LAN IP is accessible
  const phoneUrl = discoveredPhoneApiUrl || PHONE_API_URL;
  if (phoneUrl) {
    try {
      console.log(`📲 Proxying GET /api/conversations -> ${phoneUrl}`);
      const response = await axios.get(`${phoneUrl}/api/conversations`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` },
        timeout: 10000
      });

      if (Array.isArray(response.data)) {
        response.data.forEach(conv => {
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
        return res.json(response.data);
      }
    } catch (err) {
      console.error(`❌ Failed to proxy conversations via HTTP: ${err.message}`);
    }
  }

  // Fallback to local DB if proxy fails
  res.json(localConversations);
});

/**
 * GET /api/messages
 * Retrieves messages for a thread via WebSocket first, then HTTP fallback, or local DB.
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
      attachmentBase64: null
    })));
  }

  // 1. Try active WebSocket client first
  const activeWs = Array.from(devices.values()).find(ws => ws.readyState === WebSocket.OPEN);
  if (activeWs) {
    try {
      console.log(`📲 Querying /api/messages from device ${activeWs.deviceId} via WebSocket (threadId: ${threadId || 'all'})`);
      const msgs = await sendWsRequest(activeWs, {
        action: 'fetch_messages',
        threadId: threadId ? Number(threadId) : -1,
        address: address || '',
        limit: parseInt(limit) || 50,
        offset: parseInt(offset) || 0,
        includeMms: true
      }, 15000);

      if (Array.isArray(msgs) && msgs.length > 0) {
        msgs.forEach(pm => {
          let mediaPath = null;
          let mimeType = null;
          if (pm.attachmentBase64) {
            mimeType = pm.attachmentMimeType || 'image/jpeg';
            const ext = mimeType.split('/')[1] || 'jpg';
            const fileName = `${pm.id || uuidv4().slice(0, 8)}.${ext}`;
            const fullPath = path.join(mediaDir, fileName);
            try {
              if (!fs.existsSync(fullPath)) {
                fs.writeFileSync(fullPath, Buffer.from(pm.attachmentBase64, 'base64'));
              }
              mediaPath = fileName;
              pm.mediaUrl = `/media/${fileName}`;
              delete pm.attachmentBase64;
            } catch (writeErr) {
              console.error(`Failed to write sync attachment: ${writeErr.message}`);
            }
          }

          saveMessage({
            id: String(pm.id || `sync-msg-${uuidv4().slice(0, 8)}`),
            deviceId: activeWs.deviceId || 'sync',
            address: pm.address || address,
            body: pm.body || '',
            direction: pm.type === 1 ? 'inbound' : 'outbound',
            mediaPath,
            mimeType,
            timestamp: pm.date ? new Date(pm.date).toISOString() : new Date().toISOString(),
            threadId: pm.threadId || threadId,
            status: 'synced'
          });
        });
        return res.json(msgs);
      }
    } catch (wsErr) {
      console.warn(`⚠️ WebSocket messages query failed: ${wsErr.message}`);
    }
  }

  // 2. Fallback to HTTP proxy
  const phoneUrl = discoveredPhoneApiUrl || PHONE_API_URL;
  if (phoneUrl) {
    const query = new URLSearchParams(req.query).toString();
    try {
      console.log(`📲 Proxying GET /api/messages?${query} -> ${phoneUrl}`);
      const response = await axios.get(`${phoneUrl}/api/messages?${query}`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` },
        timeout: 15000
      });

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
        return res.json(response.data);
      }
    } catch (err) {
      console.error(`❌ Failed to proxy messages via HTTP: ${err.message}`);
    }
  }

  res.json(localMessages);
});

/**
 * Full Sync: Pulls every conversation and message from the phone via WebSocket or HTTP.
 */
async function syncAllFromPhone() {
  const activeWs = Array.from(devices.values()).find(ws => ws.readyState === WebSocket.OPEN);
  const phoneUrl = discoveredPhoneApiUrl || PHONE_API_URL;

  if (!activeWs && !phoneUrl) {
    console.error('❌ Cannot sync: Phone not connected via WebSocket or HTTP');
    return { error: 'Phone not connected' };
  }

  console.log('🔄 Starting Full Sync from phone...');
  try {
    let conversations = [];
    if (activeWs) {
      try {
        conversations = await sendWsRequest(activeWs, { action: 'fetch_conversations' }, 20000);
      } catch (wsErr) {
        console.warn(`WebSocket sync conversations failed: ${wsErr.message}`);
      }
    }
    if ((!conversations || conversations.length === 0) && phoneUrl) {
      const convRes = await axios.get(`${phoneUrl}/api/conversations`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` },
        timeout: 20000
      });
      conversations = convRes.data;
    }

    if (!Array.isArray(conversations)) {
      return { error: 'No conversations returned' };
    }

    console.log(`📑 Found ${conversations.length} conversations. Syncing messages...`);

    let totalMessages = 0;
    for (const conv of conversations) {
      const threadId = conv.threadId || conv.id;
      const address = conv.address;
      
      try {
        let messages = [];
        if (activeWs) {
          try {
            messages = await sendWsRequest(activeWs, {
              action: 'fetch_messages',
              threadId: Number(threadId),
              address: address || '',
              limit: 500,
              includeMms: true
            }, 30000);
          } catch (wsErr) {
            console.warn(`WS sync failed for thread ${threadId}: ${wsErr.message}`);
          }
        }
        if ((!messages || messages.length === 0) && phoneUrl) {
          const msgRes = await axios.get(`${phoneUrl}/api/messages?threadId=${threadId}&limit=500&includeMms=true`, {
            headers: { 'Authorization': `Bearer ${API_KEY}` },
            timeout: 30000
          });
          messages = msgRes.data;
        }

        if (Array.isArray(messages)) {
          messages.forEach(pm => {
            const messageId = String(pm.id || `sync-${threadId}-${pm.date}`);
            
            // Handle MMS for sync too
            let mediaPath = null;
            let mimeType = null;
            if (pm.attachmentBase64) {
              mimeType = pm.attachmentMimeType || 'image/jpeg';
              const ext = mimeType.split('/')[1] || 'jpg';
              const fileName = `${messageId}.${ext}`;
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
              mimeType: mimeType,
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
      if (devices.get(ws.deviceId) === ws) {
        devices.delete(ws.deviceId);
      }
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
