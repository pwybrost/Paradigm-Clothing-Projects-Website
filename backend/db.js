import pg from 'pg';
import { requireDatabaseUrl } from './config.js';

// Return NUMERIC columns (prices, totals) as JS numbers instead of strings.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number.parseFloat(value));

let pool;

export function getPool() {
    if (!pool) {
        pool = new pg.Pool({
            connectionString: requireDatabaseUrl(),
            // Small pool: on Vercel each function instance gets its own pool.
            max: 5,
            idleTimeoutMillis: 10_000,
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

// Runs fn(client) inside BEGIN/COMMIT, rolling back on error.
export async function withTransaction(fn) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

export async function closePool() {
    if (pool) {
        await pool.end();
        pool = undefined;
    }
}
