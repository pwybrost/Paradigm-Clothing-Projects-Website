// Public store endpoints: settings for the shop UI, newsletter signup, contact form.
import { Router } from 'express';
import { query } from '../db.js';
import { allow, ipBucket } from '../lib/rateLimit.js';
import { loadUser } from '../lib/session.js';
import { getSettings, publicSettings } from '../lib/settings.js';
import { EMAIL_RE, str } from '../lib/validation.js';
import { config, emailEnabled, paymentsEnabled } from '../config.js';
import { unsubscribeToken } from '../lib/email.js';
import { timingSafeEqual } from 'node:crypto';

const router = Router();

router.get('/settings', async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=30');
    res.json({
        ...publicSettings(await getSettings()),
        emailEnabled: emailEnabled(),
        onlinePayments: paymentsEnabled(),
        paymentMethods: paymentsEnabled() ? config.paymongoMethods : [],
    });
});

router.post('/newsletter', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const email = str(req.body?.email).toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'invalid_email' });
    if (!(await allow(ipBucket('newsletter', req), 10, 60))) return res.status(429).json({ error: 'too_many_requests' });
    await query('INSERT INTO newsletter_subscribers (email) VALUES ($1) ON CONFLICT DO NOTHING', [email]);
    res.json({ ok: true });
});

router.post('/contact', loadUser, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const name = str(req.body?.name).slice(0, 80);
    const email = str(req.body?.email).toLowerCase();
    const subject = str(req.body?.subject).slice(0, 120);
    const message = str(req.body?.message);
    if (!name) return res.status(400).json({ error: 'name_required' });
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'invalid_email' });
    if (message.length < 5 || message.length > 3000) return res.status(400).json({ error: 'invalid_message' });
    if (!(await allow(ipBucket('contact', req), 5, 60))) return res.status(429).json({ error: 'too_many_requests' });
    await query(
        'INSERT INTO contact_messages (user_id, name, email, subject, message) VALUES ($1, $2, $3, $4, $5)',
        [req.user?.id ?? null, name, email, subject, message],
    );
    res.status(201).json({ ok: true });
});

// Newsletter unsubscribe (link in every newsletter + one-click List-Unsubscribe POST).
async function unsubscribe(req, res) {
    const email = str(req.query.email).toLowerCase();
    const token = str(req.query.token);
    const expected = unsubscribeToken(email);
    const valid = token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    if (valid) await query('DELETE FROM newsletter_subscribers WHERE email = $1', [email]);
    if (req.method === 'POST') return res.status(valid ? 200 : 400).json({ ok: valid });
    res.redirect(302, `/Info.html?unsubscribed=${valid ? '1' : 'invalid'}#about`);
}
router.get('/unsubscribe', unsubscribe);
router.post('/unsubscribe', unsubscribe);

export default router;
