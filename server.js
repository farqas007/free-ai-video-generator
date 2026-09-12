'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const { HuggingFaceSpaceProvider } = require('./providers/huggingface-space-provider');

// Load .env if present (Node >=20.12 built-in, no extra dependency).
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (err) {
    console.warn(`[warn] Could not load ${envFile}: ${err.message}`);
  }
}

const PORT = Number(process.env.PORT || 3000);
const OUTPUT_DIR = path.resolve(process.env.VIDEO_OUTPUT_DIR || 'output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Provider registry. Add new providers here and select via VIDEO_PROVIDER.
const providers = {
  'huggingface-space': new HuggingFaceSpaceProvider({ outputDir: OUTPUT_DIR })
};

const providerName = String(process.env.VIDEO_PROVIDER || 'huggingface-space').toLowerCase();
const provider = providers[providerName] || providers['huggingface-space'];
if (!providers[providerName]) {
  console.warn(`[warn] Unknown VIDEO_PROVIDER "${providerName}", using "huggingface-space".`);
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PROMPT_MAX = 1000;

// POST /api/videos - start a real video generation job.
app.post('/api/videos', (req, res, next) => {
  try {
    const prompt = typeof (req.body && req.body.prompt) === 'string' ? req.body.prompt.trim() : '';
    if (!prompt) return res.status(400).json({ error: 'A non-empty "prompt" is required.' });
    if (prompt.length > PROMPT_MAX) {
      return res.status(400).json({ error: `Prompt must be ${PROMPT_MAX} characters or fewer.` });
    }
    const job = provider.generate(prompt, {});
    res.status(201).json(job);
  } catch (err) {
    next(err);
  }
});

// GET /api/videos/:id - real job state: queued | generating | ready | error.
app.get('/api/videos/:id', (req, res) => {
  const job = provider.getStatus(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job id.' });
  res.json(job);
});

// GET /api/videos/:id/file - serve the REAL generated video file (ready only).
app.get('/api/videos/:id/file', (req, res, next) => {
  const job = provider.getStatus(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job id.' });
  if (job.state !== 'ready') {
    return res.status(409).json({ error: `Video is not ready yet (state: ${job.state}).`, state: job.state });
  }
  let filePath;
  try {
    filePath = provider.getResult(req.params.id).filePath;
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(410).json({ error: 'The video file is missing from disk.' });
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) next(err);
  });
});

// GET /api/health - server + provider status.
app.get('/api/health', (_req, res) => {
  let diskFreeMb = null;
  try {
    const s = fs.statfsSync(OUTPUT_DIR);
    diskFreeMb = Math.round(((s.bavail * s.bsize) / 1024 / 1024) * 10) / 10;
  } catch {
    // ignore
  }
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    provider: provider.name,
    providerConfigured: provider.isConfigured(),
    outputDir: OUTPUT_DIR,
    diskFreeMb,
    timestamp: new Date().toISOString()
  });
});

// Minimal error handler.
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  if (!res.headersSent) {
    res.status(500).json({ error: err.message || 'Internal server error.' });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Free AI Video Generator listening on http://localhost:${PORT}`);
  console.log(`Provider: ${provider.name} | configured: ${provider.isConfigured()}`);
  console.log(`Output directory: ${OUTPUT_DIR}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);