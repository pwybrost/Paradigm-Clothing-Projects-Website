import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(backendDir, '..');

// Load .env from the project root for local development (Node >= 20.12 built-in).
// On Vercel the variables come from the project settings, so a missing file is fine.
try {
    process.loadEnvFile(path.join(rootDir, '.env'));
} catch (err) {
    if (err.code !== 'ENOENT') throw err;
}

export const config = {
    rootDir,
    backendDir,
    frontendDir: path.join(rootDir, 'frontend'),
    port: Number.parseInt(process.env.PORT ?? '3000', 10),
    // The Neon <-> Vercel integration sets DATABASE_URL (pooled) and POSTGRES_URL.
    databaseUrl: process.env.DATABASE_URL || process.env.POSTGRES_URL || '',
    isProduction: process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL),
    sessionDays: 30,
};

export function requireDatabaseUrl() {
    if (!config.databaseUrl) {
        throw new Error('DATABASE_URL is not set. Add it to .env locally or to the Vercel project environment variables.');
    }
    return config.databaseUrl;
}
