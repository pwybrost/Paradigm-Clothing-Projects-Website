import { Router } from 'express';
import { query } from '../db.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../lib/password.js';
import { createSession, destroySession, loadUser, toPublicUser } from '../lib/session.js';
import { EMAIL_RE, PASSWORD_RE, PHONE_RE, str } from '../lib/validation.js';
import { allow, clearHits, countHits, ipBucket, keyBucket, recordHit } from '../lib/rateLimit.js';
import { baseUrl, emailEnabled, isOwnerEmail } from '../config.js';
import { resetEmail, sendEmail, verifyEmail } from '../lib/email.js';
import { consumeToken, createToken } from '../lib/tokens.js';


// Sends a verification link (24h). Skipped quietly when email isn't configured.
export async function sendVerification(req, user) {
    if (!emailEnabled()) return { skipped: true };
    const token = await createToken(user.id, 'verify', 24 * 60);
    return sendEmail({ to: user.email, ...verifyEmail(user.first_name || user.username, `${baseUrl(req)}/Confirm.html?type=verify&token=${token}`) });
}

// Failed passcode attempts: 5 per account and 30 per network in 15 minutes.
const FAIL_WINDOW = 15;
const FAIL_PER_EMAIL = 5;
const FAIL_PER_IP = 30;

async function tooManyFailures(req, email) {
    const [byEmail, byIp] = await Promise.all([
        countHits(keyBucket('authfail', email), FAIL_WINDOW),
        countHits(ipBucket('authfail', req), FAIL_WINDOW),
    ]);
    return byEmail >= FAIL_PER_EMAIL || byIp >= FAIL_PER_IP;
}
async function recordFailure(req, email) {
    await Promise.all([recordHit(keyBucket('authfail', email)), recordHit(ipBucket('authfail', req))]);
}

const router = Router();

router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

router.post('/signup', async (req, res) => {
    const username = str(req.body?.username);
    const email = str(req.body?.email).toLowerCase();
    const phone = str(req.body?.phone);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!username || username.length > 50) return res.status(400).json({ error: 'invalid_username' });
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'invalid_email' });
    if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'invalid_phone' });
    if (!PASSWORD_RE.test(password) || password.length > 200) return res.status(400).json({ error: 'weak_password' });

    if (!(await allow(ipBucket('signup', req), 10, 60))) return res.status(429).json({ error: 'too_many_requests' });

    const passwordHash = await hashPassword(password);
    const { rows } = await query(
        `INSERT INTO users (email, username, phone, password_hash, role)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ((lower(email))) DO NOTHING
         RETURNING *`,
        [email, username, phone, passwordHash, isOwnerEmail(email) ? 'admin' : 'user'],
    );
    if (rows.length === 0) return res.status(409).json({ error: 'email_taken' });

    const sent = await sendVerification(req, rows[0]);
    res.status(201).json({ user: toPublicUser(rows[0]), verificationSent: Boolean(sent?.ok) });
});

router.post('/login', async (req, res) => {
    const email = str(req.body?.email).toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
    if (await tooManyFailures(req, email)) return res.status(429).json({ error: 'too_many_attempts' });

    const { rows } = await query('SELECT * FROM users WHERE lower(email) = $1', [email]);
    const user = rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
        if (!user) await burnPasswordCheck(password);
        await recordFailure(req, email);
        return res.status(401).json({ error: 'invalid_credentials' });
    }
    await clearHits(keyBucket('authfail', email));

    const role = isOwnerEmail(user.email) ? 'admin' : 'user';
    if (user.role !== role) {
        await query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1', [user.id, role]);
        user.role = role;
    }
    await createSession(req, res, user.id);
    res.json({ user: toPublicUser(user) });
});

router.post('/logout', async (req, res) => {
    await destroySession(req, res);
    res.json({ ok: true });
});

router.get('/me', loadUser, (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'not_authenticated' });
    res.json({ user: toPublicUser(req.user) });
});

// "Reset Profile" on the Login page: permanently deletes the account.
// Requires the account's email AND passcode so nobody can delete someone else's profile.
router.post('/delete-account', async (req, res) => {
    const email = str(req.body?.email).toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
    if (await tooManyFailures(req, email)) return res.status(429).json({ error: 'too_many_attempts' });

    const { rows } = await query('SELECT id, password_hash FROM users WHERE lower(email) = $1', [email]);
    const user = rows[0];
    if (!user || !(await verifyPassword(password, user.password_hash))) {
        if (!user) await burnPasswordCheck(password);
        await recordFailure(req, email);
        return res.status(401).json({ error: 'invalid_credentials' });
    }
    await clearHits(keyBucket('authfail', email));

    await query('DELETE FROM users WHERE id = $1', [user.id]); // sessions cascade; orders keep their history
    await destroySession(req, res);
    res.json({ ok: true });
});

// ---------- Email verification ----------
// Links open Confirm.html, which POSTs here when the customer clicks (email scanners don't click buttons).
router.post('/verify', async (req, res) => {
    const used = await consumeToken(req.body?.token, 'verify');
    if (!used) return res.status(400).json({ error: 'invalid_token' });
    await query('UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1', [used.user_id]);
    res.json({ ok: true });
});

router.post('/resend-verification', loadUser, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'not_authenticated' });
    if (req.user.email_verified_at) return res.json({ ok: true, alreadyVerified: true });
    if (!emailEnabled()) return res.status(503).json({ error: 'email_unavailable' });
    if (!(await allow(keyBucket('verify', req.user.id), 3, 60))) return res.status(429).json({ error: 'too_many_requests' });
    const sent = await sendVerification(req, req.user);
    res.json({ ok: Boolean(sent?.ok) });
});

// ---------- Forgot / reset passcode ----------
// Always answers OK so the form can't be used to find out which emails have accounts.
router.post('/forgot', async (req, res) => {
    const email = str(req.body?.email).toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });
    if (!emailEnabled()) return res.status(503).json({ error: 'email_unavailable' });
    const okIp = await allow(ipBucket('forgot', req), 10, 15);
    const okEmail = await allow(keyBucket('forgot', email), 3, 60);
    if (!okIp || !okEmail) return res.status(429).json({ error: 'too_many_requests' });

    const { rows } = await query('SELECT id, username, first_name, email FROM users WHERE lower(email) = $1', [email]);
    if (rows[0]) {
        const token = await createToken(rows[0].id, 'reset', 60);
        await sendEmail({ to: rows[0].email, ...resetEmail(rows[0].first_name || rows[0].username, `${baseUrl(req)}/Reset.html?token=${token}`) });
    }
    res.json({ ok: true });
});

router.post('/reset', async (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!PASSWORD_RE.test(password) || password.length > 200) return res.status(400).json({ error: 'weak_password' });
    const used = await consumeToken(req.body?.token, 'reset');
    if (!used) return res.status(400).json({ error: 'invalid_token' });
    // A working reset link proves the email address, so it also counts as verification.
    await query(
        'UPDATE users SET password_hash = $2, email_verified_at = coalesce(email_verified_at, now()), updated_at = now() WHERE id = $1',
        [used.user_id, await hashPassword(password)],
    );
    await query('DELETE FROM sessions WHERE user_id = $1', [used.user_id]); // sign out everywhere
    res.json({ ok: true });
});

// ---------- Phone change confirmation (link sent from the profile page) ----------
router.post('/confirm-phone', async (req, res) => {
    const used = await consumeToken(req.body?.token, 'phone');
    if (!used?.payload?.phone) return res.status(400).json({ error: 'invalid_token' });
    await query('UPDATE users SET phone = $2, updated_at = now() WHERE id = $1', [used.user_id, used.payload.phone]);
    res.json({ ok: true, phone: used.payload.phone });
});

export default router;
