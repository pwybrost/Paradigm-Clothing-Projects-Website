import { createHash, randomBytes } from 'node:crypto';
import { config, isOwnerEmail } from '../config.js';
import { query } from '../db.js';

export const SESSION_COOKIE = 'prdgm_session';
export const NAME_CHANGE_DAYS = 30;

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function readCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index === -1) continue;
        if (part.slice(0, index).trim() === name) {
            try {
                return decodeURIComponent(part.slice(index + 1).trim());
            } catch {
                return null;
            }
        }
    }
    return null;
}

function cookieOptions() {
    return {
        httpOnly: true,
        secure: config.isProduction,
        sameSite: 'lax',
        path: '/',
    };
}

const USER_SQL = `
    SELECT u.*, a.updated_at AS avatar_updated_at
    FROM users u LEFT JOIN user_avatars a ON a.user_id = u.id`;

// Public shape of a user. Never includes the password hash.
export function toPublicUser(row) {
    const nameChangedAt = row.name_changed_at ? new Date(row.name_changed_at) : null;
    const nextNameChangeAt = nameChangedAt
        ? new Date(nameChangedAt.getTime() + NAME_CHANGE_DAYS * 24 * 60 * 60 * 1000)
        : null;
    return {
        id: row.id,
        username: row.username,
        email: row.email,
        phone: row.phone,
        role: row.role,
        firstName: row.first_name ?? '',
        lastName: row.last_name ?? '',
        bio: row.bio ?? '',
        description: row.description ?? '',
        sizePreference: row.size_preference ?? '',
        shippingAddress: row.shipping_address ?? null,
        nameChangedAt,
        nextNameChangeAt: nextNameChangeAt && nextNameChangeAt > new Date() ? nextNameChangeAt : null,
        avatar: row.avatar_updated_at
            ? `/api/profile/avatar?v=${new Date(row.avatar_updated_at).getTime()}`
            : null,
        emailVerified: Boolean(row.email_verified_at),
        createdAt: row.created_at,
    };
}

export async function fetchUser(userId) {
    const { rows } = await query(`${USER_SQL} WHERE u.id = $1`, [userId]);
    return rows[0] ?? null;
}

export async function createSession(req, res, userId) {
    const token = randomBytes(32).toString('base64url');
    const maxAgeMs = config.sessionDays * 24 * 60 * 60 * 1000;
    await query(
        `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
         VALUES ($1, $2, now() + make_interval(days => $3::int), $4)`,
        [hashToken(token), userId, config.sessionDays, String(req.get('user-agent') ?? '').slice(0, 300)],
    );
    // Opportunistic cleanup of expired sessions.
    query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {});
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: maxAgeMs });
}

export async function destroySession(req, res) {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
    res.clearCookie(SESSION_COOKIE, cookieOptions());
}

// Signs the user out everywhere except the current browser.
export async function destroyOtherSessions(req, userId) {
    const token = readCookie(req, SESSION_COOKIE);
    const { rowCount } = await query(
        'DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2',
        [userId, token ? hashToken(token) : ''],
    );
    return rowCount;
}

// Middleware: sets req.user when a valid session cookie is present.
export async function loadUser(req, _res, next) {
    req.user = null;
    const token = readCookie(req, SESSION_COOKIE);
    if (token) {
        const { rows } = await query(
            `${USER_SQL} JOIN sessions s ON s.user_id = u.id
             WHERE s.token_hash = $1 AND s.expires_at > now()`,
            [hashToken(token)],
        );
        if (rows[0]) {
            req.user = rows[0];
            // Only the owner email can act as admin, whatever the database says.
            req.user.role = isOwnerEmail(req.user.email) ? 'admin' : 'user';
        }
    }
    next();
}

export function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'not_authenticated' });
    next();
}

export function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'not_authenticated' });
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    next();
}
