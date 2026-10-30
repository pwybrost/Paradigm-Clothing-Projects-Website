import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { closePool, query } from './db.js';
import productsRouter from './routes/products.js';

const app = express();
app.disable('x-powered-by');

// CSP is off because the pages use inline scripts/handlers and remote images
// (background, flags, placeholders). The other helmet headers still apply.
app.use(helmet({ contentSecurityPolicy: false }));

app.get('/api/health', async (_req, res) => {
    await query('SELECT 1');
    res.json({ status: 'ok' });
});

app.use('/api/products', productsRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

app.use(express.static(config.publicDir, { extensions: ['html'] }));

// Express 5 forwards rejected promises from async handlers here.
app.use((err, req, res, _next) => {
    console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err.message);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Internal server error' });
});

if (!existsSync(path.join(config.publicDir, 'css', 'tailwind.css'))) {
    console.warn('[server] public/css/tailwind.css is missing. Run `npm run build` so the Tailwind utilities load.');
}

const server = app.listen(config.port, () => {
    console.log(`[server] Paradigm running at http://localhost:${config.port}`);
});

function shutdown(signal) {
    console.log(`[server] ${signal} received, shutting down`);
    server.close(() => closePool().finally(() => process.exit(0)));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
