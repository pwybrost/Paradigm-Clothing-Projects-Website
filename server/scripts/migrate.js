import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { closePool, query } from '../db.js';

export async function migrate() {
    const sql = await readFile(path.join(config.rootDir, 'server', 'db', 'schema.sql'), 'utf8');
    await query(sql);
    console.log('[migrate] schema is up to date');
}

// Allow `node server/scripts/migrate.js` as well as importing migrate().
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    migrate()
        .catch((err) => {
            console.error('[migrate] failed:', err.message);
            process.exitCode = 1;
        })
        .finally(closePool);
}
