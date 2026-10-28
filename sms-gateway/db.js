const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const dbPath = path.join(DATA_DIR, 'sms_gateway.db');
const db = new Database(dbPath);

// Initialize database schema
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    address TEXT NOT NULL,
    body TEXT,
    direction TEXT NOT NULL, -- 'inbound' or 'outbound'
    media_path TEXT,
    mime_type TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    thread_id TEXT,
    status TEXT
  );

  CREATE TABLE IF NOT EXISTS conversations (
    thread_id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    last_message_body TEXT,
    last_message_timestamp DATETIME,
    unread_count INTEGER DEFAULT 0
  );
`);

// Create media directory if it doesn't exist
const mediaDir = path.join(DATA_DIR, 'media');
if (!fs.existsSync(mediaDir)) {
  fs.mkdirSync(mediaDir, { recursive: true });
}

/**
 * Normalize threadId so numeric values like 932 or "932.0" become "932"
 */
function normalizeThreadId(tid) {
  if (tid === null || tid === undefined || tid === '') return null;
  const s = String(tid).trim();
  if (/^-?\d+(\.0+)?$/.test(s)) {
    const n = Math.trunc(Number(s));
    return n > 0 ? String(n) : null;
  }
  return s;
}

/**
 * Generate Australian phone number variants (04..., 614..., +614...)
 */
function getAddressVariants(addr) {
  if (!addr) return [];
  const raw = String(addr).trim();
  const digits = raw.replace(/\D/g, '');
  const variants = new Set([raw]);
  if (digits.length === 10 && digits.startsWith('04')) {
    variants.add(digits);
    variants.add('61' + digits.slice(1));
    variants.add('+61' + digits.slice(1));
  } else if (digits.length === 11 && digits.startsWith('614')) {
    variants.add('0' + digits.slice(2));
    variants.add(digits);
    variants.add('+' + digits);
  }
  return Array.from(variants);
}

// One-time cleanup on startup: normalize any ".0" thread_ids and delete empty cold-call noise rows
try {
  db.exec(`
    UPDATE messages SET thread_id = CAST(CAST(thread_id AS INTEGER) AS TEXT) WHERE thread_id LIKE '%.0';
    DELETE FROM conversations WHERE thread_id LIKE '%.0' AND CAST(CAST(thread_id AS INTEGER) AS TEXT) IN (SELECT thread_id FROM conversations WHERE thread_id NOT LIKE '%.0');
    UPDATE conversations SET thread_id = CAST(CAST(thread_id AS INTEGER) AS TEXT) WHERE thread_id LIKE '%.0';
  `);
} catch (e) {
  console.warn('DB thread_id normalization warning:', e.message);
}

/**
 * Save a message to the database
 */
function saveMessage(message) {
  const { id, deviceId, address, body, direction, mediaPath, mimeType, timestamp, threadId, status } = message;
  const cleanThreadId = normalizeThreadId(threadId);
  const ts = timestamp || new Date().toISOString();

  const insert = db.prepare(`
    INSERT INTO messages (id, device_id, address, body, direction, media_path, mime_type, timestamp, thread_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      address = CASE
        WHEN excluded.address IS NOT NULL AND excluded.address != '' AND excluded.address != 'insert-address-token' THEN excluded.address
        ELSE messages.address
      END,
      body = CASE
        WHEN excluded.body IS NOT NULL AND excluded.body != '' THEN excluded.body
        ELSE COALESCE(messages.body, excluded.body)
      END,
      media_path = COALESCE(excluded.media_path, messages.media_path),
      mime_type = COALESCE(excluded.mime_type, messages.mime_type),
      thread_id = COALESCE(excluded.thread_id, messages.thread_id),
      timestamp = COALESCE(excluded.timestamp, messages.timestamp)
  `);

  insert.run(
    String(id),
    deviceId || 'unknown',
    address,
    body ?? '',
    direction || 'inbound',
    mediaPath || null,
    mimeType || null,
    ts,
    cleanThreadId,
    status || 'received'
  );

  // Update conversation summary
  const upsertConv = db.prepare(`
    INSERT INTO conversations (thread_id, address, last_message_body, last_message_timestamp)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      address = CASE
        WHEN excluded.last_message_timestamp >= COALESCE(conversations.last_message_timestamp, '')
             AND excluded.address IS NOT NULL AND excluded.address != '' AND excluded.address != 'insert-address-token'
        THEN excluded.address
        ELSE conversations.address
      END,
      last_message_body = CASE
        WHEN excluded.last_message_timestamp >= COALESCE(conversations.last_message_timestamp, '')
        THEN excluded.last_message_body
        ELSE conversations.last_message_body
      END,
      last_message_timestamp = CASE
        WHEN excluded.last_message_timestamp >= COALESCE(conversations.last_message_timestamp, '')
        THEN excluded.last_message_timestamp
        ELSE conversations.last_message_timestamp
      END
  `);

  if (cleanThreadId && address && address !== 'insert-address-token') {
    upsertConv.run(
      cleanThreadId,
      address,
      body ? body.substring(0, 100) : (mediaPath ? '[Media]' : ''),
      ts
    );
  }
}

/**
 * Find known threadIds for an address (searching all Australian format variants)
 */
function findThreadIdsForAddress(address) {
  const variants = getAddressVariants(address);
  if (variants.length === 0) return [];
  const placeholders = variants.map(() => '?').join(', ');

  const threadIds = new Set();

  // 1. Check messages table (excluding sync-conv synthetic rows first for highest accuracy)
  const msgRows = db.prepare(`
    SELECT DISTINCT thread_id FROM messages
    WHERE address IN (${placeholders})
      AND thread_id IS NOT NULL
      AND id NOT LIKE 'sync-conv-%'
    ORDER BY timestamp DESC
  `).all(...variants);
  for (const r of msgRows) {
    const clean = normalizeThreadId(r.thread_id);
    if (clean) threadIds.add(clean);
  }

  // 2. Also check conversations table
  const convRows = db.prepare(`
    SELECT DISTINCT thread_id FROM conversations
    WHERE address IN (${placeholders})
      AND thread_id IS NOT NULL
    ORDER BY last_message_timestamp DESC
  `).all(...variants);
  for (const r of convRows) {
    const clean = normalizeThreadId(r.thread_id);
    if (clean) threadIds.add(clean);
  }

  return Array.from(threadIds);
}

/**
 * Get messages for a specific address or thread
 */
function getMessages(query) {
  const { address, threadId, limit = 50, offset = 0 } = query;
  const cleanThreadId = normalizeThreadId(threadId);

  if (cleanThreadId) {
    const stmt = db.prepare(`
      SELECT * FROM messages 
      WHERE (thread_id = ? OR thread_id = ?)
        AND id NOT LIKE 'sync-conv-%'
      ORDER BY timestamp DESC 
      LIMIT ? OFFSET ?
    `);
    return stmt.all(cleanThreadId, `${cleanThreadId}.0`, limit, offset);
  } else if (address) {
    const variants = getAddressVariants(address);
    const knownThreads = findThreadIdsForAddress(address);
    const addrPlaceholders = variants.map(() => '?').join(', ');

    if (knownThreads.length > 0) {
      const threadVariants = [];
      for (const t of knownThreads) {
        threadVariants.push(t, `${t}.0`);
      }
      const threadPlaceholders = threadVariants.map(() => '?').join(', ');
      const stmt = db.prepare(`
        SELECT * FROM messages
        WHERE (address IN (${addrPlaceholders}) OR thread_id IN (${threadPlaceholders}))
          AND id NOT LIKE 'sync-conv-%'
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
      `);
      return stmt.all(...variants, ...threadVariants, limit, offset);
    }

    const stmt = db.prepare(`
      SELECT * FROM messages 
      WHERE address IN (${addrPlaceholders})
        AND id NOT LIKE 'sync-conv-%'
      ORDER BY timestamp DESC 
      LIMIT ? OFFSET ?
    `);
    return stmt.all(...variants, limit, offset);
  }

  return [];
}

/**
 * Get all conversations
 */
function getConversations(limit = 500, offset = 0) {
  const stmt = db.prepare(`
    SELECT * FROM conversations 
    ORDER BY last_message_timestamp DESC 
    LIMIT ? OFFSET ?
  `);
  return stmt.all(limit, offset);
}

module.exports = {
  saveMessage,
  getMessages,
  getConversations,
  findThreadIdsForAddress,
  getAddressVariants,
  normalizeThreadId,
  mediaDir
};
