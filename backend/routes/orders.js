import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { buildQuote, parseCartItems, releaseOrder } from '../lib/pricing.js';
import { loadUser, requireAuth } from '../lib/session.js';
import { getSettings } from '../lib/settings.js';
import { str } from '../lib/validation.js';

const router = Router();
const PHONE_RE = /^[+0-9 ()-]{7,25}$/;
const RETURN_WINDOW_DAYS = 30;

router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

export function toOrderDto(order, items, returns = []) {
    return {
        id: order.id,
        status: order.status,
        itemCount: order.item_count,
        subtotal: order.subtotal ?? order.total,
        bundleDiscount: order.bundle_discount ?? 0,
        discount: order.discount ?? 0,
        discountCode: order.discount_code ?? null,
        shippingFee: order.shipping_fee ?? 0,
        total: order.total,
        shippingAddress: order.shipping_address ?? null,
        contactPhone: order.contact_phone ?? '',
        paymentMethod: order.payment_method ?? 'cod',
        notes: order.notes ?? '',
        courier: order.courier ?? '',
        trackingNumber: order.tracking_number ?? '',
        customerName: order.customer_name,
        customerEmail: order.customer_email,
        createdAt: order.created_at,
        updatedAt: order.updated_at,
        items: items.map((i) => ({
            productId: i.product_id,
            title: i.title,
            size: i.size ?? '',
            color: i.color ?? '',
            isPreorder: i.is_preorder ?? false,
            unitPrice: i.unit_price,
            quantity: i.quantity,
            lineTotal: i.line_total,
        })),
        returns: returns.map((r) => ({
            id: r.id, kind: r.kind, reason: r.reason, details: r.details,
            status: r.status, adminNote: r.admin_note, createdAt: r.created_at, updatedAt: r.updated_at,
        })),
    };
}

async function loadOrders(whereSql, params) {
    const { rows: orders } = await query(`SELECT * FROM orders ${whereSql}`, params);
    if (orders.length === 0) return [];
    const ids = orders.map((o) => o.id);
    const [{ rows: items }, { rows: returns }] = await Promise.all([
        query('SELECT * FROM order_items WHERE order_id = ANY($1::bigint[]) ORDER BY id', [ids]),
        query('SELECT * FROM return_requests WHERE order_id = ANY($1::bigint[]) ORDER BY created_at DESC', [ids]),
    ]);
    const itemsBy = Map.groupBy(items, (i) => String(i.order_id));
    const returnsBy = Map.groupBy(returns, (r) => String(r.order_id));
    return orders.map((o) => toOrderDto(o, itemsBy.get(String(o.id)) ?? [], returnsBy.get(String(o.id)) ?? []));
}

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

// ---------- Public: price a cart (guests can see totals and test discount codes) ----------
router.post('/quote', async (req, res) => {
    const { lines, error } = parseCartItems(req.body?.items);
    if (error) return res.status(400).json({ error });
    const settings = await getSettings();
    const quote = await buildQuote({ query }, lines, { discountCode: req.body?.discountCode, settings });
    res.json({ quote });
});

router.use(loadUser, requireAuth);

// ---------- Place an order (Cash on Delivery until a payment gateway is connected) ----------
router.post('/', async (req, res) => {
    const { lines, error } = parseCartItems(req.body?.items);
    if (error) return res.status(400).json({ error });
    const ship = readShipping(req.body?.shipping);
    if (ship.error) return res.status(400).json({ error: ship.error });
    const notes = str(req.body?.notes).slice(0, 500);
    const discountCode = str(req.body?.discountCode);

    const result = await withTransaction(async (client) => {
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
                                 payment_method, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'cod', $13) RETURNING *`,
            [req.user.id, req.user.email, ship.shipping.name || req.user.username, quote.itemCount, quote.subtotal,
                quote.bundleDiscount, quote.discount, quote.discountCode, quote.shippingFee, quote.total,
                ship.shipping, ship.phone, notes],
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
        if (req.body?.saveAddress === true) {
            const { name, ...address } = ship.shipping;
            await client.query('UPDATE users SET shipping_address = $2, updated_at = now() WHERE id = $1', [req.user.id, address]);
        }
        return { status: 201, body: { order: toOrderDto(order, items) } };
    });

    res.status(result.status).json(result.body);
});

router.get('/mine', async (req, res) => {
    const orders = await loadOrders('WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200', [req.user.id]);
    res.json({ orders });
});

// One order (for the receipt). Owners can open any order.
router.get('/:id', async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_order' });
    const isAdmin = req.user.role === 'admin';
    const [order] = isAdmin
        ? await loadOrders('WHERE id = $1', [req.params.id])
        : await loadOrders('WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    res.json({ order });
});

// Customers can cancel while pending. Stock and the discount-code use are returned.
router.post('/:id/cancel', async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_order' });
    const outcome = await withTransaction(async (client) => {
        const { rows } = await client.query(
            `UPDATE orders SET status = 'cancelled', updated_at = now()
             WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING id`,
            [req.params.id, req.user.id],
        );
        if (rows.length === 0) return null;
        await releaseOrder(client, rows[0].id);
        return rows[0].id;
    });
    if (!outcome) {
        const exists = await query('SELECT status FROM orders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
        if (exists.rowCount === 0) return res.status(404).json({ error: 'order_not_found' });
        return res.status(409).json({ error: 'order_not_cancellable', status: exists.rows[0].status });
    }
    const [order] = await loadOrders('WHERE id = $1', [outcome]);
    res.json({ order });
});

// Return / exchange request for a shipped or completed order, within 30 days.
router.post('/:id/returns', async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_order' });
    const kind = str(req.body?.kind);
    const reason = str(req.body?.reason).slice(0, 120);
    const details = str(req.body?.details).slice(0, 1000);
    if (!['return', 'exchange'].includes(kind)) return res.status(400).json({ error: 'invalid_kind' });
    if (!reason) return res.status(400).json({ error: 'reason_required' });

    const { rows } = await query(
        `SELECT status, updated_at FROM orders WHERE id = $1 AND user_id = $2`,
        [req.params.id, req.user.id],
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'order_not_found' });
    if (!['shipped', 'completed'].includes(order.status)) return res.status(409).json({ error: 'not_returnable' });
    if (Date.now() - new Date(order.updated_at).getTime() > RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
        return res.status(409).json({ error: 'return_window_closed' });
    }
    try {
        await query(
            `INSERT INTO return_requests (order_id, user_id, kind, reason, details) VALUES ($1, $2, $3, $4, $5)`,
            [req.params.id, req.user.id, kind, reason, details],
        );
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'return_already_open' });
        throw err;
    }
    const [dto] = await loadOrders('WHERE id = $1', [req.params.id]);
    res.status(201).json({ order: dto });
});

export default router;
