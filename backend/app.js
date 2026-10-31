// Express app shared by local development (backend/server.js) and Vercel (api/index.js).
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { query } from './db.js';
import authRouter from './routes/auth.js';
import ordersRouter from './routes/orders.js';
import productsRouter from './routes/products.js';
import profileRouter from './routes/profile.js';
import wishlistRouter from './routes/wishlist.js';
import adminRouter from './routes/admin/index.js';
import storeRouter from './routes/store.js';
import paymentsRouter from './routes/payments.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Vercel terminates TLS in front of the function

// CSP is off because the pages use inline scripts/handlers and remote images
// (background, flags, placeholders). The other helmet headers still apply.
app.use(helmet({ contentSecurityPolicy: false }));
// The PayMongo webhook needs the raw body for its signature, so it's mounted before the JSON parser.
app.use('/api/payments', paymentsRouter);

// Profile pictures are sent as base64 JSON, so that one route gets a bigger body limit.
app.use('/api/profile/avatar', express.json({ limit: '1mb' }));
// Product photo uploads (Vercel caps request bodies at 4.5 MB).
app.use('/api/admin/products', express.json({ limit: '4mb' }));
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', async (_req, res) => {
    await query('SELECT 1');
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
});

app.use('/api/auth', authRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/products', productsRouter);
app.use('/api/profile', profileRouter);
app.use('/api/wishlist', wishlistRouter);
app.use('/api/admin', adminRouter);
app.use('/api/store', storeRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

// Locally Express also serves the frontend. On Vercel, frontend/ is served by the CDN instead.
if (!process.env.VERCEL) {
    app.use(express.static(config.frontendDir, { extensions: ['html'] }));
}

// Express 5 forwards rejected promises from async handlers here.
app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err.message);
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal_error' });
});

export default app;
