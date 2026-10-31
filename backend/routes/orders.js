import { Router } from 'express';
import { baseUrl, emailEnabled, paymentsEnabled } from '../config.js';
import { query, withTransaction } from '../db.js';
import {
    emailOrderPlaced, loadOrder, loadOrders, maybeExpireUnpaidOrders, syncPayment, toOrderDto,
} from '../lib/orders.js';
import { createCheckoutSession, expireCheckoutSession } from '../lib/paymongo.js';
import { buildQuote, parseCartItems, releaseOrder } from '../lib/pricing.js';
import { loadUser, requireAuth } from '../lib/session.js';
import { getSettings } from '../lib/settings.js';
import { str } from '../lib/validation.js';

export { toOrderDto };

const router = Router();
const PHONE_RE = /^[+0-9 ()-]{7,25}$/;
const RETURN_WINDOW_DAYS = 30;

router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

function readShipping(body) {
    const a = body && typeof body === 'object' ? body : {};
    const shipping = {
        name: str(a.name).slice(0, 80),
        line1: str(a.line1).slice(0, 120),
        line2: str(a.line2).slice(0, 120),
        city: str(a.city).slice(0, 60),
        province: str(a.province).slice(0, 60),
        postalCode: str(a.postalCode).slice(0, 12),
        country: str(a.country).slice(0, 60) || 'Philippines',
    };
    const phone = str(a.phone);
    if (!shipping.name || !shipping.line1 || !shipping.city || !shipping.province || !shipping.postalCode) {
        return { error: 'shipping_incomplete' };
    }
    if (!PHONE_RE.test(phone)) return { error: 'invalid_phone' };
    return { shipping, phone };
}

// Starts (or restarts) a PayMongo checkout for an order. Returns the checkout URL.
async function startPayment(order, req) {
    const { rows } = await query('SELECT payment_session_id FROM orders WHERE id = $1', [order.id]);
    const previous = rows[0]?.payment_session_id;
    const session = await createCheckoutSession(order, baseUrl(req));
    await query(
        `UPDATE orders SET payment_method = 'online', payment_status = 'awaiting', payment_session_id = $2,
                payment_started_at = now(), updated_at = now()
         WHERE id = $1`,
        [order.id, session.id],
    );
    if (previous && previous !== session.id) await expireCheckoutSession(previous);
    return session.url;
}

// ---------- Public: price a cart (guests can see totals and test discount codes) ----------
router.post('/quote', async (req, res) => {
    const { lines, error } = parseCartItems(req.body?.items);
    if (error) return res.status(400).json({ error });
    const settings = await getSettings();
    const quote = await buildQuote({ query }, lines, { discountCode: req.body?.discountCode, settings });
    res.json({ quote });
});

router.use(loadUser, requireAuth);

// ---------- Place an order (Cash on Delivery or online via PayMongo) ----------
router.post('/', async (req, res) => {
    await maybeExpireUnpaidOrders(); // frees stock held by abandoned online payments
    if (emailEnabled() && !req.user.email_verified_at) return res.status(403).json({ error: 'email_unverified' });

    const { lines, error } = parseCartItems(req.body?.items);
    if (error) return res.status(400).json({ error });
    const ship = readShipping(req.body?.shipping);
    if (ship.error) return res.status(400).json({ error: ship.error });
    const notes = str(req.body?.notes).slice(0, 500);
    const discountCode = str(req.body?.discountCode);
    const online = req.body?.paymentMethod === 'online';
    if (online && !paymentsEnabled()) return res.status(400).json({ error: 'payments_unavailable' });
    // Same request id as an earlier attempt (e.g. resent after the connection dropped): return that order.
    const requestId = /^[\w-]{8,64}$/.test(str(req.body?.requestId)) ? str(req.body.requestId) : null;
    if (requestId) {
        const [existing] = await loadOrders('WHERE user_id = $1 AND client_request_id = $2', [req.user.id, requestId]);
        if (existing) return res.status(200).json({ order: existing, duplicate: true });
    }

    let result;
    try {
        result = await withTransaction(async (client) => {
        const settings = await getSettings(client);
        const quote = await buildQuote(client, lines, { discountCode, settings, lock: true });
        if (quote.problems.length) return { status: 409, body: { error: 'cart_problem', problems: quote.problems } };
        if (discountCode && quote.codeError) return { status: 409, body: { error: 'discount_invalid', codeError: quote.codeError } };
        if (quote.lines.length === 0) return { status: 400, body: { error: 'invalid_items' } };

        for (const l of quote.lines) {
            if (l.isPreorder) continue;
            const { rowCount } = await client.query(
                `UPDATE product_variants SET stock = stock - $4
                 WHERE product_id = $1 AND color = $2 AND size = $3 AND stock >= $4`,
                [l.productId, l.color, l.size, l.quantity],
            );
            if (rowCount === 0) throw new Error('stock changed during checkout');
        }
        if (quote.discountCode) {
            await client.query('UPDATE discount_codes SET used_count = used_count + 1 WHERE code = $1', [quote.discountCode]);
        }

        const { rows } = await client.query(
            `INSERT INTO orders (user_id, customer_email, customer_name, item_count, subtotal, bundle_discount,
                                 discount, discount_code, shipping_fee, total, shipping_address, contact_phone,
                                 payment_method, payment_status, notes, client_request_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
            [req.user.id, req.user.email, ship.shipping.name || req.user.username, quote.itemCount, quote.subtotal,
                quote.bundleDiscount, quote.discount, quote.discountCode, quote.shippingFee, quote.total,
                ship.shipping, ship.phone, online ? 'online' : 'cod', online ? 'awaiting' : 'unpaid', notes, requestId],
        );
        const order = rows[0];
        const items = [];
        for (const l of quote.lines) {
            const { rows: itemRows } = await client.query(
                `INSERT INTO order_items (order_id, product_id, title, size, color, is_preorder,
                                          unit_price, unit_cost, quantity, line_total)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
                [order.id, l.productId, l.title, l.size, l.color, l.isPreorder, l.unitPrice, l.unitCost, l.quantity, l.lineTotal],
            );
            items.push(itemRows[0]);
        }
        await client.query('DELETE FROM carts WHERE user_id = $1', [req.user.id]); // bought: clear the saved cart
        if (req.body?.saveAddress === true) {
            const { name: _name, ...address } = ship.shipping;
            await client.query('UPDATE users SET shipping_address = $2, updated_at = now() WHERE id = $1', [req.user.id, address]);
        }
        return { status: 201, body: { order: toOrderDto(order, items) } };
        });
    } catch (err) {
        // Two copies of the same retried request raced each other: the other one won, return it.
        if (err.code === '23505' && requestId) {
            const [existing] = await loadOrders('WHERE user_id = $1 AND client_request_id = $2', [req.user.id, requestId]);
            if (existing) return res.status(200).json({ order: existing, duplicate: true });
        }
        throw err;
    }

    if (result.status !== 201) return res.status(result.status).json(result.body);
    const order = result.body.order;

    if (!online) {
        await emailOrderPlaced(order, req);
        return res.status(201).json({ order });
    }

    // Online: hand the customer to PayMongo. If PayMongo is down, cancel so stock isn't stuck.
    try {
        const checkoutUrl = await startPayment(order, req);
        return res.status(201).json({ order: await loadOrder(order.id), checkoutUrl });
    } catch (err) {
        console.error('[payments] checkout session failed:', err.message);
        await withTransaction(async (client) => {
            await client.query(`UPDATE orders SET status = 'cancelled', payment_status = 'failed', updated_at = now() WHERE id = $1`, [order.id]);
            await releaseOrder(client, order.id);
        });
        return res.status(502).json({ error: 'payment_unavailable' });
    }
});

router.get('/mine', async (req, res) => {
    await maybeExpireUnpaidOrders();
    const orders = await loadOrders('WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200', [req.user.id]);
    res.json({ orders });
});

async function ownOrder(req) {
    if (!/^\d{1,18}$/.test(req.params.id)) return null;
    const [order] = req.user.role === 'admin'
        ? await loadOrders('WHERE id = $1', [req.params.id])
        : await loadOrders('WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    return order ?? null;
}

// One order (for the receipt). Owners can open any order.
router.get('/:id', async (req, res) => {
    const order = await ownOrder(req);
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    res.json({ order });
});

// Called when the customer comes back from PayMongo: confirms the payment directly,
// so the order shows as paid even if the webhook hasn't arrived yet.
router.get('/:id/payment', async (req, res) => {
    const order = await ownOrder(req);
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    try {
        const updated = await syncPayment(order);
        if (updated) {
            await emailOrderPlaced(updated, req);
            return res.json({ order: updated });
        }
    } catch (err) {
        console.warn('[payments] sync failed:', err.message);
    }
    res.json({ order });
});

// Pay now / retry payment for a pending order (also switches a COD order to online).
router.post('/:id/pay', async (req, res) => {
    if (!paymentsEnabled()) return res.status(400).json({ error: 'payments_unavailable' });
    if (emailEnabled() && !req.user.email_verified_at) return res.status(403).json({ error: 'email_unverified' });
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_order' });
    const [order] = await loadOrders('WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    if (order.status !== 'pending' || order.paymentStatus === 'paid') return res.status(409).json({ error: 'not_payable' });
    try {
        const checkoutUrl = await startPayment(order, req);
        res.json({ checkoutUrl });
    } catch (err) {
        console.error('[payments] retry failed:', err.message);
        res.status(502).json({ error: 'payment_unavailable' });
    }
});

// Customers can cancel while pending and unpaid. Stock and the discount-code use are returned.
router.post('/:id/cancel', async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_order' });
    const outcome = await withTransaction(async (client) => {
        const { rows } = await client.query(
            `UPDATE orders SET status = 'cancelled',
                    payment_status = CASE WHEN payment_status = 'awaiting' THEN 'expired' ELSE payment_status END,
                    updated_at = now()
             WHERE id = $1 AND user_id = $2 AND status = 'pending' AND payment_status <> 'paid'
             RETURNING id, payment_session_id`,
            [req.params.id, req.user.id],
        );
        if (rows.length === 0) return null;
        await releaseOrder(client, rows[0].id);
        return rows[0];
    });
    if (!outcome) {
        const exists = await query('SELECT status FROM orders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
        if (exists.rowCount === 0) return res.status(404).json({ error: 'order_not_found' });
        return res.status(409).json({ error: 'order_not_cancellable', status: exists.rows[0].status });
    }
    if (outcome.payment_session_id && paymentsEnabled()) await expireCheckoutSession(outcome.payment_session_id);
    res.json({ order: await loadOrder(outcome.id) });
});

// Return / exchange request for a shipped or completed order, within 30 days.
router.post('/:id/returns', async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_order' });
    const kind = str(req.body?.kind);
    const reason = str(req.body?.reason).slice(0, 120);
    const details = str(req.body?.details).slice(0, 1000);
    if (!['return', 'exchange'].includes(kind)) return res.status(400).json({ error: 'invalid_kind' });
    if (!reason) return res.status(400).json({ error: 'reason_required' });

    const { rows } = await query('SELECT status, updated_at FROM orders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    if (!['shipped', 'completed'].includes(order.status)) return res.status(409).json({ error: 'not_returnable' });
    if (Date.now() - new Date(order.updated_at).getTime() > RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
        return res.status(409).json({ error: 'return_window_closed' });
    }
    try {
        await query(
            'INSERT INTO return_requests (order_id, user_id, kind, reason, details) VALUES ($1, $2, $3, $4, $5)',
            [req.params.id, req.user.id, kind, reason, details],
        );
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'return_already_open' });
        throw err;
    }
    res.status(201).json({ order: await loadOrder(req.params.id) });
});

export default router;
