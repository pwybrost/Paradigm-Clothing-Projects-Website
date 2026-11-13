// Local development server: `npm run dev` or `npm start`.
import { existsSync } from 'node:fs';
import path from 'node:path';
import app from './app.js';
import { config } from './config.js';
import { closePool } from './db.js';

if (!existsSync(path.join(config.frontendDir, 'css', 'tailwind.css'))) {
    console.warn('[server] frontend/css/tailwind.css is missing. Run `npm run build` so the Tailwind utilities load.');
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
