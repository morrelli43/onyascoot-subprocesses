const express = require('express');
const cors = require('cors');
const Docker = require('dockerode');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4316;
const OPS_WEBHOOK_URL = process.env.OPS_WEBHOOK_URL;
const OPS_API_KEY = process.env.OPS_API_KEY;
// The name of the project to filter containers
const COMPOSE_PROJECT_NAME = process.env.COMPOSE_PROJECT_NAME || 'onyascoot-subprocesses';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// In-memory state
// { "containerName": { id: "xxx", status: "running", state: "running", since: "2024...", lastChanged: "2024..." } }
const statuses = {};

// Helper to notify Operations portal
async function notifyOperations(containerName, oldStatus, newStatus) {
    if (!OPS_WEBHOOK_URL) return;
    
    try {
        console.log(`[Monitor] Notifying operations about ${containerName} status change: ${oldStatus} -> ${newStatus}`);
        const response = await fetch(OPS_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(OPS_API_KEY ? { 'X-API-Key': OPS_API_KEY } : {})
            },
            body: JSON.stringify({
                event: 'container_status_change',
                containerName,
                oldStatus,
                newStatus,
                timestamp: new Date().toISOString()
            })
        });
        
        if (!response.ok) {
            console.error(`[Monitor] Failed to notify operations: ${response.statusText}`);
        }
    } catch (err) {
        console.error(`[Monitor] Error notifying operations:`, err.message);
    }
}

async function pollContainers() {
    try {
        // Find containers belonging to our docker-compose project
        const containers = await docker.listContainers({ all: true });
        
        const projectContainers = containers.filter(c => {
            return c.Labels['com.docker.compose.project'] === COMPOSE_PROJECT_NAME;
        });

        const currentNames = new Set();

        for (const c of projectContainers) {
            let name = c.Names[0];
            if (name.startsWith('/')) name = name.substring(1);
            
            // Remove project prefix if using standard compose naming (e.g. onyascoot-subprocesses-contact-sync-1)
            const serviceLabel = c.Labels['com.docker.compose.service'];
            const displayObj = {
                id: c.Id,
                name: name,
                service: serviceLabel || name,
                state: c.State, // 'running', 'exited', 'dead', 'restarting', etc.
                status: c.Status // 'Up 2 hours', 'Exited (1) 2 minutes ago', etc.
            };

            currentNames.add(displayObj.service);

            const existing = statuses[displayObj.service];
            if (!existing) {
                statuses[displayObj.service] = {
                    ...displayObj,
                    lastChanged: new Date().toISOString()
                };
                // Don't notify on first discovery
            } else if (existing.state !== displayObj.state) {
                const oldState = existing.state;
                statuses[displayObj.service] = {
                    ...displayObj,
                    lastChanged: new Date().toISOString()
                };
                await notifyOperations(displayObj.service, oldState, displayObj.state);
            } else {
                // Update dynamic status (e.g. "Up 2 hours" -> "Up 3 hours") without triggering webhook
                statuses[displayObj.service].status = displayObj.status;
                statuses[displayObj.service].id = displayObj.id; // in case it was recreated
            }
        }

        // Check if any containers disappeared
        for (const service of Object.keys(statuses)) {
            if (!currentNames.has(service) && statuses[service].state !== 'missing') {
                const oldState = statuses[service].state;
                statuses[service].state = 'missing';
                statuses[service].status = 'Container removed';
                statuses[service].lastChanged = new Date().toISOString();
                await notifyOperations(service, oldState, 'missing');
            }
        }

    } catch (err) {
        console.error(`[Monitor] Polling error:`, err.message);
    }
}

// Start polling
setInterval(pollContainers, 10000);
// Initial poll
pollContainers();

// --- HTTP API ---

app.get('/api/status', (req, res) => {
    res.json(statuses);
});

app.get('/api/logs/:service', async (req, res) => {
    const service = req.params.service;
    const lines = parseInt(req.query.lines) || 100;
    
    const info = statuses[service];
    if (!info || !info.id) {
        return res.status(404).json({ error: 'Service not found or missing ID' });
    }

    try {
        const container = docker.getContainer(info.id);
        const logsStream = await container.logs({
            stdout: true,
            stderr: true,
            tail: lines,
            timestamps: true
        });

        // Parse docker log stream
        // Docker raw streams are multiplexed. We need to strip the 8-byte headers.
        let output = '';
        if (typeof logsStream === 'string') {
            // Sometimes it comes back as string
            output = logsStream;
        } else {
            // Buffer stream
            output = logsStream.toString('utf8');
            // Clean up multiplexed headers if present (01 00 00 00 00 00 00 length)
            // A simple regex to strip binary headers (this is rudimentary)
            output = output.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, '');
        }

        // Just returning raw lines
        const logLines = output.split('\n').filter(l => l.trim() !== '');
        
        // Take last N lines explicitly just to be safe
        const tailLines = logLines.slice(-lines);

        res.json({ logs: tailLines });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch logs', details: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Monitor] Service listening on port ${PORT}`);
});
