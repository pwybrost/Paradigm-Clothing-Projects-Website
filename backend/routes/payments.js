// PayMongo webhook + scheduled cleanup.
import { Router, raw } from 'express';
import { config } from '../config.js';
import { query } from '../db.js';
import { emailOrderPlaced, expireUnpaidOrders, markOrderPaid } from '../lib/orders.js';
import { sessionPayment, verifyWebhook } from '../lib/paymongo.js';

const router = Router();

// PayMongo -> POST /api/payments/webhook (register this URL in the PayMongo dashboard,
// event "checkout_session.payment.paid"). The raw body is needed to check the signature.
router.post('/webhook', raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!verifyWebhook(rawBody, req.get('paymongo-signature'))) {
        console.warn('[payments] webhook rejected: bad signature');
        return res.status(401).json({ error: 'invalid_signature' });
    }
    let event;
    try {
        event = JSON.parse(rawBody);
    } catch {
        return res.status(400).json({ error: 'invalid_json' });
    }
    const eventId = String(event?.data?.id ?? '');
    const type = String(event?.data?.attributes?.type ?? '');
    if (!eventId) return res.status(400).json({ error: 'invalid_event' });

    // Handle each event once (PayMongo retries until it gets a 2xx).
    const { rowCount } = await query('INSERT INTO payment_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING', [eventId, type]);
    if (rowCount === 0) return res.json({ ok: true, duplicate: true });

    if (type === 'checkout_session.payment.paid') {
        const session = event.data.attributes.data;
        const sessionId = session?.id;
        // Only trust sessions we created for that order.
        const { rows } = await query('SELECT id FROM orders WHERE payment_session_id = $1', [sessionId]);
        const orderId = rows[0]?.id;
        if (!orderId) {
            console.warn(`[payments] paid event for unknown session ${sessionId}`);
        } else {
            const { reference } = sessionPayment(session);
            const order = await markOrderPaid(orderId, reference);
            if (order) await emailOrderPlaced(order, req);
        }
    }
    res.json({ ok: true });
});

// Vercel Cron (see vercel.json) -> GET /api/payments/cron with "Authorization: Bearer <CRON_SECRET>".
router.get('/cron', async (req, res) => {
    if (!config.cronSecret || req.get('authorization') !== `Bearer ${config.cronSecret}`) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    const expired = await expireUnpaidOrders();
    await query("DELETE FROM rate_limits WHERE created_at < now() - interval '1 day'");
    await query("DELETE FROM email_tokens WHERE expires_at < now() - interval '7 days'");
    await query("DELETE FROM sessions WHERE expires_at < now()");
    res.set('Cache-Control', 'no-store').json({ ok: true, expired });
});

export default router;
