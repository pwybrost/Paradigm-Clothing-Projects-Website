import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env from the project root if it exists (Node >= 20.12 built-in, no dotenv needed).
try {
    process.loadEnvFile(path.join(rootDir, '.env'));
} catch (err) {
    if (err.code !== 'ENOENT') throw err;
}

export const config = {
    rootDir,
    publicDir: path.join(rootDir, 'public'),
    port: Number.parseInt(process.env.PORT ?? '3000', 10),
    databaseUrl: process.env.DATABASE_URL,
};

export function requireDatabaseUrl() {
    if (!config.databaseUrl) {
        throw new Error('DATABASE_URL is not set. Copy .env.example to .env and paste your Neon connection string.');
    }
    return config.databaseUrl;
}
