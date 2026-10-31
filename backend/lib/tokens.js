// One-time email links. The raw token goes in the email; only its SHA-256 hash is stored.
import { createHash, randomBytes } from 'node:crypto';
import { query } from '../db.js';

const hash = (t) => createHash('sha256').update(t).digest('hex');

// Creates a token, invalidating older unused ones of the same purpose for that user.
export async function createToken(userId, purpose, minutes, payload = null) {
    const token = randomBytes(32).toString('base64url');
    await query('DELETE FROM email_tokens WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL', [userId, purpose]);
    await query(
        `INSERT INTO email_tokens (token_hash, user_id, purpose, payload, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5::int))`,
        [hash(token), userId, purpose, payload, minutes],
    );
    query("DELETE FROM email_tokens WHERE expires_at < now() - interval '7 days'").catch(() => {});
    return token;
}

// Marks the token used and returns { user_id, payload }, or null if invalid/expired/used.
// Done in one UPDATE so a link can't be used twice.
export async function consumeToken(token, purpose, db = { query }) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const { rows } = await db.query(
        `UPDATE email_tokens SET used_at = now()
         WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
         RETURNING user_id, payload`,
        [hash(token), purpose],
    );
    return rows[0] ?? null;
}
