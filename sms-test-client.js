const WebSocket = require('ws');

// CONFIGURATION
const API_KEY = 'tVBTaBYsSZijbXP6gXgI2t46TBwMxswn';
const DEVICE_ID = 'ONYA_TEST_DEVICE_01';
const WS_URL = `wss://portal.onyascoot.com/sms-relay/?apiKey=${API_KEY}&deviceId=${DEVICE_ID}`;

console.log(`🔗 Connecting to ${WS_URL.split('?')[0]} (with credentials in query)...`);

const ws = new WebSocket(WS_URL, {
  headers: {
    'authorization': `Bearer ${API_KEY}`,
    'x-device-id': DEVICE_ID
  }
});

ws.on('open', () => {
  console.log('✅ Connected to Relay Server!');
  console.log('---');
  console.log('Waiting for "send_sms" commands from the portal...');
});

ws.on('message', (data) => {
  console.log('\n📩 Received command from Relay:');
  const payload = JSON.parse(data);
  console.log(JSON.stringify(payload, null, 2));

  if (payload.action === 'send_sms') {
    console.log(`📲 SIMULATING: Sending SMS to ${payload.data.address}: "${payload.data.body}"`);
  }
});

ws.on('close', () => {
  console.log('❌ Disconnected from server.');
});

ws.on('error', (err) => {
  console.error('❌ WebSocket Error:', err.message);
});

// To test forwarding, you can send a message up to the server:
// setInterval(() => {
//   const msg = { type: 'incoming_sms', from: '+1987654321', text: 'Hello from phone!' };
//   ws.send(JSON.stringify(msg));
//   console.log('🚀 Sent incoming simulated SMS to relay');
// }, 10000);
