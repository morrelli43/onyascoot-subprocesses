const express = require('express');
const axios = require('axios');
const http = require('http');
const WebSocket = require('ws');

// 1. Mock Operations Portal
const mockOpsApp = express();
mockOpsApp.use(express.json());
mockOpsApp.post('/api/communication/inbound', (req, res) => {
    console.log('--- Mock Ops Portal Received ---');
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Body:', JSON.stringify(req.body, null, 2));
    
    // Validate
    if (req.headers.authorization === 'Bearer TEST_OPS_KEY' && 
        req.body.address === '+61400000000' && 
        req.body.body === 'Test message' &&
        req.body.direction === 'inbound') {
        console.log('✅ Mock Ops: Validation Success!');
        res.json({ success: true });
    } else {
        console.log('❌ Mock Ops: Validation Failed!');
        res.status(400).json({ error: 'Invalid request' });
    }
});
const mockOpsServer = mockOpsApp.listen(5001, () => {
    console.log('Mock Operations Portal listening on port 5001');
});

// 2. Set Env Vars for Gateway
process.env.SMS_GATEWAY_API_KEY = 'TEST_GW_KEY';
process.env.OPERATIONS_API_KEY = 'TEST_OPS_KEY';
process.env.WEB_PORTAL_INCOMING_URL = 'http://localhost:5001/api/communication/inbound';
process.env.PORT = '5002';

// 3. Start Gateway (require the actual server.js)
// We need to bypass the process.exit(1) if API_KEY is missing, but we set it above.
const gateway = require('./server.js');

// 4. Client to simulate phone sending via WebSocket
setTimeout(() => {
    const ws = new WebSocket('ws://localhost:5002/?apiKey=TEST_GW_KEY&deviceId=TEST_DEVICE');
    
    ws.on('open', () => {
        console.log('Connected to Gateway WS');
        const incomingSms = {
            type: 'incoming_sms',
            from: '+61400000000',
            text: 'Test message'
        };
        ws.send(JSON.stringify(incomingSms));
    });

    ws.on('message', (data) => {
        console.log('Gateway Response (WS):', data.toString());
    });

    // Cleanup after test
    setTimeout(() => {
        console.log('Cleaning up...');
        ws.close();
        mockOpsServer.close();
        process.exit(0);
    }, 5000);
}, 2000);
