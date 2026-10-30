import pg from 'pg';
import { requireDatabaseUrl } from './config.js';

// Return NUMERIC columns (prices) as JS numbers instead of strings.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number.parseFloat(value));

let pool;

export function getPool() {
    if (!pool) {
        pool = new pg.Pool({
            connectionString: requireDatabaseUrl(),
            max: 10,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 10_000,
        });
        // Neon closes idle connections; log instead of crashing the process.
        pool.on('error', (err) => console.error('[db] idle client error:', err.message));
    }
    return pool;
}

export function query(text, params) {
    return getPool().query(text, params);
}

export async function closePool() {
    if (pool) {
        await pool.end();
        pool = undefined;
    }
}
