import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { plannerChat } from './agents/planner.js';
import { runPipeline } from './orchestrator.js';
import { deployerAgent } from './agents/deployer.js';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(cors());
app.use(express.json());

// In-memory session store
const sessions = new Map();

let currentPreview = null; // { outDir: string }

// Serve Next.js static assets for preview (must be before other routes)
app.use('/_next', (req, res, next) => {
  if (!currentPreview) return next();
  const assetPath = path.join(currentPreview.outDir, '_next', req.path);
  res.sendFile(assetPath, (err) => { if (err) next(); });
});

// Serve preview app
app.use('/preview', (req, res, next) => {
  if (!currentPreview) return res.status(404).send('No preview available');
  const reqPath = req.path === '/' ? '/index.html' : req.path;
  const filePath = path.join(currentPreview.outDir, reqPath);
  res.sendFile(filePath, (err) => {
    if (err) {
      // Try index.html for SPA routing
      res.sendFile(path.join(currentPreview.outDir, 'index.html'), (err2) => {
        if (err2) next();
      });
    }
  });
});

app.use(express.static(path.join(__dirname, 'public')));

// POST /api/chat
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  try {
    const events = [];
    const emit = (event) => events.push(event);

    const result = await plannerChat(messages, emit);
    res.json({ response: result.response, ready: result.ready, events });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/build
app.post('/api/build', (req, res) => {
  const { plan } = req.body;
  if (!plan) {
    return res.status(400).json({ error: 'plan is required' });
  }

  const sessionId = uuidv4();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);

  const session = {
    status: 'running',
    events: [],
    emitter,
    deployUrl: null,
    workDir: null,
    subdomain: null,
  };
  sessions.set(sessionId, session);

  const emit = (event) => {
    session.events.push(event);
    emitter.emit('event', event);
    if (event.type === 'build_complete') {
      session.status = 'built';
      session.workDir = event.workDir;
      session.subdomain = event.subdomain;
      currentPreview = { outDir: path.join(event.workDir, 'out') };
    } else if (event.type === 'pipeline_complete') {
      session.status = 'complete';
      session.deployUrl = event.deployUrl;
    } else if (event.type === 'pipeline_error') {
      session.status = 'error';
    }
  };

  // Run pipeline in background
  runPipeline(plan, sessionId, emit).catch((err) => {
    console.error('Pipeline error:', err);
    emit({ type: 'pipeline_error', error: err.message });
  });

  res.json({ sessionId });
});

// POST /api/deploy/:sessionId
app.post('/api/deploy/:sessionId', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session || !session.workDir) {
    return res.status(404).json({ error: 'Session not found or not built yet' });
  }
  res.json({ ok: true });

  const deployEmit = (event) => {
    session.events.push(event);
    session.emitter.emit('event', event);
    if (event.type === 'pipeline_complete') {
      session.status = 'complete';
      session.deployUrl = event.deployUrl;
    } else if (event.type === 'pipeline_error') {
      session.status = 'error';
    }
  };

  deployerAgent(session.workDir, req.params.sessionId, session.subdomain, deployEmit).catch((err) => {
    deployEmit({ type: 'pipeline_error', error: err.message });
  });
});

// GET /api/session/:sessionId
app.get('/api/session/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({
    status: session.status,
    events: session.events,
    deployUrl: session.deployUrl,
  });
});

// WebSocket server
wss.on('connection', (ws) => {
  let subscribedSessionId = null;
  let eventListener = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'subscribe' && msg.sessionId) {
        subscribedSessionId = msg.sessionId;
        const session = sessions.get(subscribedSessionId);

        if (!session) {
          ws.send(JSON.stringify({ type: 'error', error: 'Session not found' }));
          return;
        }

        // Replay buffered events
        for (const event of session.events) {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(event));
          }
        }

        // Listen for new events
        eventListener = (event) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(event));
          }
        };
        session.emitter.on('event', eventListener);
      }
    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  });

  ws.on('close', () => {
    if (subscribedSessionId && eventListener) {
      const session = sessions.get(subscribedSessionId);
      if (session) {
        session.emitter.off('event', eventListener);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Pixel server running on http://localhost:${PORT}`);
});
