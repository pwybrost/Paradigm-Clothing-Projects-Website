// Safety net for new databases (e.g. a fresh Neon preview branch where the build had no DATABASE_URL):
// on the first API request, create the tables and store the photos if they're missing.
// Normal deploys already do this at build time, so this is usually a single quick check.
import { config } from '../config.js';
import { query } from '../db.js';

let ready;

async function ensure() {
    const { rows } = await query(`
        SELECT to_regclass('public.product_variants') IS NOT NULL AND to_regclass('public.payment_events') IS NOT NULL AS migrated,
               CASE WHEN to_regclass('public.products') IS NULL THEN 0 ELSE (SELECT count(*) FROM products)::int END AS products`);
    const { migrated, products } = rows[0];
    if (!migrated) {
        const { migrate } = await import('../scripts/migrate.js');
        await migrate();
        console.log('[bootstrap] schema created at runtime');
    }
    if (!products) {
        const { rows: d } = await query('SELECT count(*)::int AS n FROM deleted_products');
        if (d[0].n === 0) {
            const { seedCatalog } = await import('../scripts/seed.js');
            await seedCatalog();
            console.log('[bootstrap] catalogue seeded at runtime');
        }
    }
}

export function ensureDatabase() {
    if (!config.databaseUrl) return Promise.resolve();
    ready ??= ensure().catch((err) => { ready = undefined; throw err; });
    return ready;
}
