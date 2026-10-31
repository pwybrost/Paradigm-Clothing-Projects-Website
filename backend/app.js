// Express app shared by local development (backend/server.js) and Vercel (api/index.js).
import express from 'express';
import helmet from 'helmet';
import { config, emailEnabled, paymentsEnabled } from './config.js';
import { query } from './db.js';
import { ensureDatabase } from './lib/bootstrap.js';
import authRouter from './routes/auth.js';
import ordersRouter from './routes/orders.js';
import productsRouter from './routes/products.js';
import profileRouter from './routes/profile.js';
import wishlistRouter from './routes/wishlist.js';
import adminRouter from './routes/admin/index.js';
import storeRouter from './routes/store.js';
import paymentsRouter from './routes/payments.js';
import seoRouter from './routes/seo.js';

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

// Open /api/health to check the setup. It shows what's connected, never secrets.
app.get('/api/health', async (_req, res) => {
    const out = {
        status: 'ok',
        environment: process.env.VERCEL_ENV || 'local',
        commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null,
        node: process.version,
        database: { configured: Boolean(config.databaseUrl), pooled: config.databaseUrl.includes('-pooler') },
        email: emailEnabled(),
        payments: paymentsEnabled(),
    };
    if (!config.databaseUrl) {
        out.status = 'error';
        out.database.hint = 'DATABASE_URL is missing for this environment. In Vercel, connect the Neon integration (or add DATABASE_URL) for Production and Preview, then redeploy.';
        return res.status(503).set('Cache-Control', 'no-store').json(out);
    }
    try {
        const { rows } = await query(`
            SELECT to_regclass('public.products') IS NOT NULL AS tables,
                   (SELECT count(*) FROM pg_tables WHERE schemaname = 'public')::int AS table_count`);
        out.database.connected = true;
        out.database.tablesCreated = rows[0].tables;
        if (rows[0].tables) {
            const c = await query(`SELECT (SELECT count(*) FROM products)::int AS products,
                                          (SELECT count(*) FROM product_images)::int AS images,
                                          (SELECT count(*) FROM product_variants)::int AS sizes,
                                          (SELECT count(*) FROM users)::int AS accounts,
                                          (SELECT count(*) FROM users WHERE role = 'admin')::int AS owners`);
            Object.assign(out.database, c.rows[0]);
            if (!c.rows[0].products) { out.status = 'warning'; out.database.hint = 'No products yet. Redeploy so the build stores the photos (it runs migrate + seed).'; }
            if (!c.rows[0].owners) out.ownerHint = 'No owner account yet. Sign up with the email in ADMIN_EMAILS, then log in again.';
        } else {
            out.status = 'error';
            out.database.hint = 'Connected, but tables are missing. Redeploy (the build creates them), or run "npm run db:setup" locally.';
        }
    } catch (err) {
        out.status = 'error';
        out.database.connected = false;
        out.database.error = err.code || 'connection_failed';
        out.database.message = String(err.message).slice(0, 200);
        out.database.hint = 'Check DATABASE_URL in Vercel (password changed? copy the new connection string from Neon) and redeploy.';
    }
    res.status(out.status === 'error' ? 503 : 200).set('Cache-Control', 'no-store').json(out);
});

// Creates tables / stores photos on first use if the build couldn't (health check excluded).
app.use('/api', async (req, _res, next) => {
    if (req.path === '/health') return next();
    await ensureDatabase();
    next();
});

app.use('/api/auth', authRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/products', productsRouter);
app.use('/api/profile', profileRouter);
app.use('/api/wishlist', wishlistRouter);
app.use('/api/admin', adminRouter);
app.use('/api/store', storeRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

// Product share pages (/p/:id) and the live sitemap. On Vercel these are rewritten to the function.
app.use(async (req, _res, next) => { if (req.path === '/sitemap.xml' || req.path.startsWith('/p/')) await ensureDatabase(); next(); });
app.use(seoRouter);

// Locally Express also serves the frontend. On Vercel, frontend/ is served by the CDN instead.
if (!process.env.VERCEL) {
    app.use(express.static(config.frontendDir, { extensions: ['html'] }));
}

// Express 5 forwards rejected promises from async handlers here.
app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err);
    if (res.headersSent) return;
    // Database/system error codes (e.g. 42P01 = missing table, 28P01 = wrong password) help diagnose setup problems.
    res.status(500).json({ error: 'internal_error', code: err.code && /^[A-Z0-9_]{3,40}$/i.test(err.code) ? err.code : undefined });
});

export default app;
