'use strict';
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { HttpError } = require('./util');
const seed = require('./seed');

// Ensure schema + seed data are present before serving.
seed.run();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(express.json({ limit: config.bodyLimit }));
app.use(cookieParser());

// Basic security headers (no external CDN dependency).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// Lightweight request logging (method, path, status, ms).
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      // eslint-disable-next-line no-console
      console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
    }
  });
  next();
});

// Health check.
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// API routes.
app.use('/api', require('./routes/auth.routes'));
app.use('/api', require('./routes/state.routes'));
app.use('/api', require('./routes/budget.routes'));
app.use('/api', require('./routes/dist.routes'));
app.use('/api', require('./routes/letter.routes'));
app.use('/api', require('./routes/note.routes'));
app.use('/api', require('./routes/audit.routes'));
app.use('/api', require('./routes/master.routes'));
app.use('/api', require('./routes/products.routes'));
app.use('/api', require('./routes/admin.routes'));

// Unknown API route -> JSON 404 (so the SPA fallback never swallows API typos).
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found', code: 'NO_ROUTE' }));

// Static frontend.
app.use(express.static(path.join(config.root, 'public'), { index: 'index.html', extensions: ['html'] }));

// SPA fallback (non-API GETs) -> index.html.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(config.root, 'public', 'index.html'));
});

// Central error handler -> consistent JSON error shape.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err instanceof HttpError ? err.status : (err.status || 500);
  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error('[error]', err);
  }
  res.status(status).json({ error: err.message || 'Server error', code: err.code });
});

const server = app.listen(config.port, config.host, () => {
  // eslint-disable-next-line no-console
  console.log(`UDC Debit Note System running at http://${config.host}:${config.port} (${config.nodeEnv})`);
});

// Graceful shutdown.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => process.exit(0)); });
}

module.exports = app;
