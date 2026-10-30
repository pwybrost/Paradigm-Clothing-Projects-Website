import { Router } from 'express';
import { query } from '../db.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../lib/password.js';
import { createSession, destroySession, loadUser, toPublicUser } from '../lib/session.js';

const router = Router();

// Same rules as the Signup page.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+[0-9 (),]{1,25} \d{10}$/; // "<country code> <10 digits>", e.g. "+63 9123456789"
const PASSWORD_RE = /^(?=(?:.*?\d){2})(?=(?:.*?[!@#$%^&*(),.?":{}|<>]){2}).{8,}$/;

const str = (value) => (typeof value === 'string' ? value.trim() : '');

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

    const { rows } = await query('SELECT * FROM users WHERE lower(email) = $1', [email]);
    const user = rows[0];
    if (!user) {
        await burnPasswordCheck(password);
        return res.status(401).json({ error: 'invalid_credentials' });
    }
    if (!(await verifyPassword(password, user.password_hash))) {
        return res.status(401).json({ error: 'invalid_credentials' });
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

    const { rows } = await query('SELECT id, password_hash FROM users WHERE lower(email) = $1', [email]);
    const user = rows[0];
    if (!user) {
        await burnPasswordCheck(password);
        return res.status(401).json({ error: 'invalid_credentials' });
    }
    if (!(await verifyPassword(password, user.password_hash))) {
        return res.status(401).json({ error: 'invalid_credentials' });
    }

    await query('DELETE FROM users WHERE id = $1', [user.id]); // sessions cascade; orders keep their history
    await destroySession(req, res);
    res.json({ ok: true });
});

export default router;
