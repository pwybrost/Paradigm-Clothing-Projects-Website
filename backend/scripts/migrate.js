import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { closePool, getPool } from '../db.js';

// Arbitrary constant so concurrent deploys (production + preview) don't migrate at the same time.
const MIGRATION_LOCK_ID = 726_001;

export async function migrate() {
    const sql = await readFile(path.join(config.backendDir, 'db', 'schema.sql'), 'utf8');
    const client = await getPool().connect();
    try {
        await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
        await client.query(sql);
        console.log('[migrate] schema is up to date');
        // The owner list is the single source of truth: listed accounts are admin, everyone else is a member.
        const { rows } = await client.query(
            `UPDATE users SET role = CASE WHEN lower(email) = ANY($1::text[]) THEN 'admin' ELSE 'user' END, updated_at = now()
             WHERE role <> CASE WHEN lower(email) = ANY($1::text[]) THEN 'admin' ELSE 'user' END
             RETURNING email, role`,
            [config.adminEmails],
        );
        for (const r of rows) console.log(`[migrate] ${r.email} is now ${r.role}`);
    } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
        client.release();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    // --if-configured: used by the Vercel build so a deploy without a database doesn't fail outright.
    if (!config.databaseUrl && process.argv.includes('--if-configured')) {
        console.warn('[migrate] DATABASE_URL not set; skipping migration');
    } else {
        migrate()
            .catch((err) => {
                console.error('[migrate] failed:', err.message);
                process.exitCode = 1;
            })
            .finally(closePool);
    }
}
