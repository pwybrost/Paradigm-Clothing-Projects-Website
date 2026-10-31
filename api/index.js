// Vercel Function entry point. vercel.json rewrites /api/* (and /p/*) here, and the Express app in
// backend/ routes it. The app is loaded lazily so a startup failure (bad env var, missing module)
// returns a readable JSON error instead of an opaque FUNCTION_INVOCATION_FAILED page.
let appPromise;
const loadApp = () => (appPromise ??= import('../backend/app.js').then((m) => m.default));

export default async function handler(req, res) {
    let app;
    try {
        app = await loadApp();
    } catch (err) {
        appPromise = undefined; // retry on the next request
        console.error('[api] failed to start:', err);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ error: 'server_start_failed', detail: `${err.name}: ${err.message}`.slice(0, 300) }));
        return;
    }
    return app(req, res);
}
