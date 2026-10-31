// Database-backed rate limiting. In-memory counters don't work on Vercel because
// every function instance has its own memory.
import { createHash } from 'node:crypto';
import { query } from '../db.js';

const hash = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 32);

export const ipBucket = (name, req) => `${name}:ip:${hash(req.ip ?? 'unknown')}`;
export const keyBucket = (name, key) => `${name}:k:${hash(String(key).toLowerCase())}`;

// Number of hits recorded in the last `windowMinutes`.
export async function countHits(bucket, windowMinutes) {
    const { rows } = await query(
        `SELECT count(*)::int AS n FROM rate_limits
         WHERE bucket = $1 AND created_at > now() - make_interval(mins => $2::int)`,
        [bucket, windowMinutes],
    );
    return rows[0].n;
}

export async function recordHit(bucket) {
    await query('INSERT INTO rate_limits (bucket) VALUES ($1)', [bucket]);
    // Occasional cleanup of old rows.
    if (Math.random() < 0.05) query("DELETE FROM rate_limits WHERE created_at < now() - interval '1 day'").catch(() => {});
}

export async function clearHits(bucket) {
    await query('DELETE FROM rate_limits WHERE bucket = $1', [bucket]);
}

// Records a hit and returns false if the bucket was already at its limit.
export async function allow(bucket, limit, windowMinutes) {
    if ((await countHits(bucket, windowMinutes)) >= limit) return false;
    await recordHit(bucket);
    return true;
}
