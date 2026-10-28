const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const {
  saveMessage,
  getMessages,
  getConversations,
  findThreadIdsForAddress,
  getAddressVariants,
  normalizeThreadId,
  mediaDir
} = require('./db');
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

// In-memory cache of conversations from the phone so repeated syncs don't block 25s
let cachedPhoneConversations = null;
let cachedPhoneConversationsAt = 0;
let inFlightConversationsPromise = null;

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

function cacheAndPersistConversations(convs, deviceId = 'sync') {
  if (!Array.isArray(convs) || convs.length === 0) return;
  cachedPhoneConversations = convs;
  cachedPhoneConversationsAt = Date.now();
  convs.forEach(conv => {
    const tid = normalizeThreadId(conv.threadId || conv.id);
    if (!tid || !conv.address) return;
    saveMessage({
      id: `sync-conv-${tid}`,
      deviceId: deviceId || 'sync',
      address: conv.address,
      body: conv.snippet || conv.body || '',
      direction: 'inbound',
      timestamp: conv.date ? new Date(conv.date).toISOString() : new Date().toISOString(),
      threadId: tid,
      status: 'synced'
    });
  });
}

function processAndPersistPhoneMessages(msgs, fallbackAddress, fallbackThreadId, deviceId = 'sync') {
  if (!Array.isArray(msgs)) return [];
  return msgs.map(pm => {
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
    } else if (pm.isMms && pm.id) {
      // Check if media file already exists on disk from a previous sync
      for (const ext of ['jpeg', 'jpg', 'png', 'gif', 'webp', 'mp4', 'amr']) {
        const candidate = `${pm.id}.${ext}`;
        if (fs.existsSync(path.join(mediaDir, candidate))) {
          mediaPath = candidate;
          pm.mediaUrl = `/media/${candidate}`;
          break;
        }
      }
    }

    // For outbound MMS where MmsHelper returned own number (+61493678198) or insert-address-token, prefer fallbackAddress
    let effectiveAddress = pm.address || fallbackAddress;
    if (
      fallbackAddress &&
      (!effectiveAddress ||
        effectiveAddress === 'insert-address-token' ||
        effectiveAddress.includes('493678198'))
    ) {
      effectiveAddress = fallbackAddress;
    }

    const cleanTid = normalizeThreadId(pm.threadId || fallbackThreadId);
    pm.threadId = cleanTid ? Number(cleanTid) : pm.threadId;

    saveMessage({
      id: String(pm.id || `sync-msg-${uuidv4().slice(0, 8)}`),
      deviceId: deviceId || 'sync',
      address: effectiveAddress,
      body: pm.body || '',
      direction: pm.type === 1 ? 'inbound' : 'outbound',
      mediaPath,
      mimeType,
      timestamp: pm.date ? new Date(pm.date).toISOString() : (pm.timestamp ? new Date(pm.timestamp).toISOString() : new Date().toISOString()),
      threadId: cleanTid,
      status: 'synced'
    });

    return pm;
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

        // Even if the caller timed out waiting for fetch_conversations_response, always cache it when it arrives!
        if (raw.action === 'fetch_conversations_response' && Array.isArray(raw.data)) {
          cacheAndPersistConversations(raw.data, deviceId);
        }

        // Check if this is a response to a pending request (fetch_conversations, fetch_messages)
        if (raw.action === 'fetch_conversations_response' || raw.action === 'fetch_messages_response') {
          const pending = pendingWsRequests.get(raw.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingWsRequests.delete(raw.requestId);
            pending.resolve(raw.data || []);
            return;
          }
          return;
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
        const isColdCall = raw.event === 'cold_call' || inner.event === 'cold_call' || raw.type === 'cold_call' || inner.type === 'cold_call';
        const messageId = String(raw.id || inner.id || `msg-${uuidv4().slice(0, 8)}`);
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
        const threadId = normalizeThreadId(inner.threadId || inner.thread_id || raw.threadId || raw.thread_id);
        const rawTime = inner.timestamp || raw.timestamp;
        const timestamp = rawTime ? (typeof rawTime === 'number' ? new Date(rawTime).toISOString() : new Date(rawTime).toISOString()) : new Date().toISOString();

        if (address) {
          // Do not save cold_call events into the SMS messages table (they have empty body and pollute SMS deduplication)
          if (!isColdCall) {
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
          }

          // Strip huge base64 fields before forwarding to Operations so payloads stay lightweight
          const cleanRaw = { ...raw };
          delete cleanRaw.attachmentBase64;
          delete cleanRaw.media;
          const cleanInner = typeof raw.data === 'object' ? { ...raw.data } : {};
          delete cleanInner.attachmentBase64;
          delete cleanInner.media;

          // Forward directly to the Operations App webhook
          const targetUrl = process.env.WEB_PORTAL_INCOMING_URL || 'http://172.17.43.13:3010/api/webhooks/sms';
          try {
            const mediaUrl = mediaPath ? `/media/${mediaPath}` : null;
            // Map device payload to Onyascoot Operations format
            const forwardData = {
              ...cleanRaw,
              address: address,
              body: body,
              direction: 'inbound',
              message_uid: messageId,
              threadId: threadId,
              deviceId: deviceId,
              deviceName: ws.deviceName || null,
              mediaUrl: mediaUrl,
              timestamp,
              data: {
                ...cleanInner,
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
              await axios.post(targetUrl, forwardData, { headers, timeout: 10000 });
              console.log(`🚀 Forwarded inbound ${isColdCall ? 'cold_call' : 'SMS/MMS'} to Operations: ${targetUrl}`);
            } catch(firstErr) {
              console.error(`⚠️ Failed to forward to ${targetUrl}: ${firstErr.message}, trying fallback https://portal.onyascoot.com/api/webhooks/sms`);
              await axios.post('https://portal.onyascoot.com/api/webhooks/sms', forwardData, { headers, timeout: 10000 });
              console.log(`🚀 Forwarded inbound ${isColdCall ? 'cold_call' : 'SMS/MMS'} to external interface: https://portal.onyascoot.com/api/webhooks/sms`);
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
    
    // Save outbound message to local DB (skip 'dial' actions so they don't create empty-body messages)
    const messageId = `msg-out-${uuidv4().slice(0, 8)}`;
    if (action !== 'dial') {
      saveMessage({
        id: messageId,
        deviceId,
        address,
        body: body || '',
        direction: 'outbound',
        timestamp: new Date().toISOString(),
        status: 'pending'
      });
    }

    res.json({ status: 'sent', action, deviceId, message_uid: messageId });
  } catch (err) {
    console.error(`❌ Error sending to device ${deviceId}:`, err.message);
    res.status(500).json({ error: 'Failed to relay message to device' });
  }
});

/**
 * GET /api/conversations
 * Retrieves all SMS threads from the phone via WebSocket first, or cached/local DB.
 */
app.get('/api/conversations', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // First, check local database
  const localConversations = getConversations().map(c => ({
    address: c.address,
    snippet: c.last_message_body,
    date: new Date(c.last_message_timestamp).getTime(),
    threadId: Number(c.thread_id) || c.thread_id
  }));

  if (localConversations.length > 0 && req.query.sync !== 'true') {
    console.log(`📦 Serving ${localConversations.length} conversations from local DB`);
    return res.json(localConversations);
  }

  // If we have a fresh in-memory cache (< 60s old), merge it with localConversations and return immediately!
  if (cachedPhoneConversations && (Date.now() - cachedPhoneConversationsAt < 60000) && req.query.force !== 'true') {
    const mergedMap = new Map();
    for (const c of cachedPhoneConversations) {
      mergedMap.set(String(normalizeThreadId(c.threadId || c.id)), c);
    }
    for (const lc of localConversations) {
      const tid = String(normalizeThreadId(lc.threadId));
      if (!mergedMap.has(tid)) {
        mergedMap.set(tid, lc);
      }
    }
    const merged = Array.from(mergedMap.values());
    console.log(`⚡ Serving ${merged.length} conversations from memory cache + local DB`);
    return res.json(merged);
  }

  // 1. Try active WebSocket client first (deduplicating concurrent in-flight requests)
  const activeWs = Array.from(devices.values()).find(ws => ws.readyState === WebSocket.OPEN);
  if (activeWs) {
    try {
      if (!inFlightConversationsPromise) {
        console.log(`📲 Querying /api/conversations from device ${activeWs.deviceId} via WebSocket`);
        inFlightConversationsPromise = sendWsRequest(activeWs, { action: 'fetch_conversations' }, 30000)
          .finally(() => {
            inFlightConversationsPromise = null;
          });
      }
      const convs = await inFlightConversationsPromise;
      if (Array.isArray(convs) && convs.length > 0) {
        cacheAndPersistConversations(convs, activeWs.deviceId);
        // Merge in any local conversations (e.g. threads > 783 or MMS-only threads) not in simple=true
        const mergedMap = new Map();
        for (const c of convs) {
          mergedMap.set(String(normalizeThreadId(c.threadId || c.id)), c);
        }
        for (const lc of localConversations) {
          const tid = String(normalizeThreadId(lc.threadId));
          if (!mergedMap.has(tid)) {
            mergedMap.set(tid, lc);
          }
        }
        return res.json(Array.from(mergedMap.values()));
      }
    } catch (wsErr) {
      console.warn(`⚠️ WebSocket conversations query failed: ${wsErr.message}`);
    }
  } else if (PHONE_API_URL) {
    // 2. Fallback to HTTP proxy only if PHONE_API_URL is explicitly configured and no WS is active
    try {
      console.log(`📲 Proxying GET /api/conversations -> ${PHONE_API_URL}`);
      const response = await axios.get(`${PHONE_API_URL}/api/conversations`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` },
        timeout: 5000
      });

      if (Array.isArray(response.data)) {
        cacheAndPersistConversations(response.data, 'sync');
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
 * Format local DB rows to the standard API message format
 */
function formatLocalMessages(rows) {
  return rows.map(m => ({
    id: m.id,
    address: m.address,
    body: m.body,
    type: m.direction === 'inbound' ? 1 : 2,
    date: new Date(m.timestamp).getTime(),
    timestamp: new Date(m.timestamp).getTime(),
    threadId: Number(m.thread_id) || m.thread_id,
    mediaUrl: m.media_path ? `/media/${m.media_path}` : null,
    attachmentBase64: null
  }));
}

/**
 * GET /api/messages
 * Retrieves messages for a thread or address via WebSocket + local DB merge.
 */
app.get('/api/messages', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { address, threadId, limit, offset, sync } = req.query;
  const parsedLimit = parseInt(limit) || 50;
  const parsedOffset = parseInt(offset) || 0;

  // First, check local database
  const localMessages = getMessages({ address, threadId, limit: parsedLimit, offset: parsedOffset });
  if (localMessages.length > 0 && sync !== 'true') {
    console.log(`📦 Serving ${localMessages.length} messages from local DB`);
    return res.json(formatLocalMessages(localMessages));
  }

  // 1. Try active WebSocket client first
  const activeWs = Array.from(devices.values()).find(ws => ws.readyState === WebSocket.OPEN);
  if (activeWs) {
    try {
      const cleanReqThreadId = normalizeThreadId(threadId);
      const threadIdsToQuery = new Set();
      if (cleanReqThreadId) {
        threadIdsToQuery.add(cleanReqThreadId);
      } else if (address) {
        // Resolve known thread IDs for this address (e.g. both SMS thread 932 and MMS thread 933)
        for (const tid of findThreadIdsForAddress(address)) {
          threadIdsToQuery.add(tid);
        }
      }

      const collectedPhoneMsgs = [];
      const queriedThreadIds = new Set();

      // A) Query each known threadId directly on the phone (most reliable — works regardless of 04/+61 format)
      for (const tid of threadIdsToQuery) {
        queriedThreadIds.add(String(tid));
        try {
          console.log(`📲 Querying /api/messages from device ${activeWs.deviceId} via WebSocket (threadId: ${tid})`);
          const msgs = await sendWsRequest(activeWs, {
            action: 'fetch_messages',
            threadId: Number(tid),
            address: address || '',
            limit: parsedLimit,
            offset: parsedOffset,
            includeMms: true
          }, 15000);
          if (Array.isArray(msgs) && msgs.length > 0) {
            const processed = processAndPersistPhoneMessages(msgs, address, tid, activeWs.deviceId);
            collectedPhoneMsgs.push(...processed);
          }
        } catch (tidErr) {
          console.warn(`⚠️ WebSocket messages query failed for threadId ${tid}: ${tidErr.message}`);
        }
      }

      // B) If address was provided (and either no threadId was known or we also want to check +61 / 61 variants on the phone)
      if (address && (!cleanReqThreadId)) {
        const variants = getAddressVariants(address);
        // Prefer +61... and 61... first because Android's canonical-addresses uses international format
        const orderedVariants = variants.sort((a, b) => {
          const score = s => (s.startsWith('+61') ? 0 : s.startsWith('61') ? 1 : 2);
          return score(a) - score(b);
        });

        for (const addrVariant of orderedVariants) {
          // If we already found messages and we've checked +61 and 61 variants, don't waste time on 04 (which throws SecurityException on non-default SMS app)
          if (collectedPhoneMsgs.length > 0 && addrVariant.startsWith('0')) {
            continue;
          }
          try {
            console.log(`📲 Querying /api/messages from device ${activeWs.deviceId} via WebSocket (address: ${addrVariant})`);
            const msgs = await sendWsRequest(activeWs, {
              action: 'fetch_messages',
              threadId: -1,
              address: addrVariant,
              limit: parsedLimit,
              offset: parsedOffset,
              includeMms: true
            }, 12000);
            if (Array.isArray(msgs) && msgs.length > 0) {
              const processed = processAndPersistPhoneMessages(msgs, address, null, activeWs.deviceId);
              collectedPhoneMsgs.push(...processed);
            }
          } catch (addrErr) {
            console.warn(`⚠️ WebSocket messages query failed for address ${addrVariant}: ${addrErr.message}`);
          }
        }
      }

      // Refresh localMessages after persisting everything from the phone so we return the complete union
      const updatedLocal = getMessages({ address, threadId, limit: Math.max(parsedLimit, 200), offset: parsedOffset });
      if (updatedLocal.length > 0 || collectedPhoneMsgs.length > 0) {
        // Deduplicate by message id, preferring collectedPhoneMsgs combined with updatedLocal
        const mergedById = new Map();
        for (const m of formatLocalMessages(updatedLocal)) {
          mergedById.set(String(m.id), m);
        }
        for (const pm of collectedPhoneMsgs) {
          const existing = mergedById.get(String(pm.id));
          mergedById.set(String(pm.id), {
            ...existing,
            ...pm,
            mediaUrl: pm.mediaUrl || (existing ? existing.mediaUrl : null)
          });
        }
        const mergedList = Array.from(mergedById.values()).sort((a, b) => (b.date || b.timestamp || 0) - (a.date || a.timestamp || 0));
        return res.json(mergedList);
      }
    } catch (wsErr) {
      console.warn(`⚠️ WebSocket messages query failed: ${wsErr.message}`);
    }
  } else if (PHONE_API_URL) {
    // 2. Fallback to HTTP proxy only if PHONE_API_URL is configured and no WS device is connected
    const query = new URLSearchParams(req.query).toString();
    try {
      console.log(`📲 Proxying GET /api/messages?${query} -> ${PHONE_API_URL}`);
      const response = await axios.get(`${PHONE_API_URL}/api/messages?${query}`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` },
        timeout: 8000
      });

      if (Array.isArray(response.data)) {
        const processed = processAndPersistPhoneMessages(response.data, address, threadId, 'sync');
        return res.json(processed);
      }
    } catch (err) {
      console.error(`❌ Failed to proxy messages via HTTP: ${err.message}`);
    }
  }

  res.json(formatLocalMessages(localMessages));
});

/**
 * Full Sync: Pulls every conversation and message from the phone via WebSocket or HTTP.
 */
async function syncAllFromPhone() {
  const activeWs = Array.from(devices.values()).find(ws => ws.readyState === WebSocket.OPEN);
  const phoneUrl = PHONE_API_URL;

  if (!activeWs && !phoneUrl) {
    console.error('❌ Cannot sync: Phone not connected via WebSocket or HTTP');
    return { error: 'Phone not connected' };
  }

  console.log('🔄 Starting Full Sync from phone...');
  try {
    let conversations = [];
    if (activeWs) {
      try {
        conversations = await sendWsRequest(activeWs, { action: 'fetch_conversations' }, 30000);
        if (Array.isArray(conversations)) {
          cacheAndPersistConversations(conversations, activeWs.deviceId);
        }
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
      const threadId = normalizeThreadId(conv.threadId || conv.id);
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
          processAndPersistPhoneMessages(messages, address, threadId, 'sync-full');
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
