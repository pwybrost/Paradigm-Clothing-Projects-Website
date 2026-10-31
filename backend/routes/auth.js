import { Router } from 'express';
import { query } from '../db.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../lib/password.js';
import { createSession, destroySession, loadUser, toPublicUser } from '../lib/session.js';
import { EMAIL_RE, PASSWORD_RE, PHONE_RE, str } from '../lib/validation.js';
import { allow, clearHits, countHits, ipBucket, keyBucket, recordHit } from '../lib/rateLimit.js';

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
        `INSERT INTO users (email, username, phone, password_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ((lower(email))) DO NOTHING
         RETURNING *`,
        [email, username, phone, passwordHash],
    );
    if (rows.length === 0) return res.status(409).json({ error: 'email_taken' });

    res.status(201).json({ user: toPublicUser(rows[0]) });
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

export default router;
