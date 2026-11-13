// Owner-only order management: every customer's orders, status, tracking, returns, CSV export.
import { Router } from 'express';
import { query, withTransaction } from '../../db.js';
import { releaseOrder } from '../../lib/pricing.js';
import { str } from '../../lib/validation.js';
import { toOrderDto } from '../orders.js';
import { baseUrl } from '../../config.js';
import { emailOrderStatus, loadOrder } from '../../lib/orders.js';
import { returnUpdateEmail, sendEmail } from '../../lib/email.js';

const router = Router();
const STATUSES = ['pending', 'paid', 'shipped', 'completed', 'cancelled'];
const RETURN_STATUSES = ['requested', 'approved', 'rejected', 'completed'];

async function loadAdminOrders(whereSql, params) {
    const { rows: orders } = await query(
        `SELECT o.*, u.first_name, u.last_name, u.phone AS account_phone
         FROM orders o LEFT JOIN users u ON u.id = o.user_id
         ${whereSql}`,
        params,
    );
    if (orders.length === 0) return [];
    const ids = orders.map((o) => o.id);
    const [{ rows: items }, { rows: returns }] = await Promise.all([
        query('SELECT * FROM order_items WHERE order_id = ANY($1::bigint[]) ORDER BY id', [ids]),
        query('SELECT * FROM return_requests WHERE order_id = ANY($1::bigint[]) ORDER BY created_at DESC', [ids]),
    ]);
    const itemsBy = Map.groupBy(items, (i) => String(i.order_id));
    const returnsBy = Map.groupBy(returns, (r) => String(r.order_id));
    return orders.map((o) => {
        const orderItems = itemsBy.get(String(o.id)) ?? [];
        const dto = toOrderDto(o, orderItems, returnsBy.get(String(o.id)) ?? []);
        dto.items.forEach((item, i) => { item.unitCost = orderItems[i].unit_cost; });
        dto.customer = {
            userId: o.user_id,
            email: o.customer_email,
            name: o.customer_name,
            fullName: [o.first_name, o.last_name].filter(Boolean).join(' ') || null,
            phone: o.contact_phone || o.account_phone || null,
            shippingAddress: o.shipping_address ?? null,
            accountDeleted: !o.user_id,
        };
        return dto;
    });
}

router.get('/', async (_req, res) => {
    res.json({ orders: await loadAdminOrders('ORDER BY o.created_at DESC LIMIT 1000', []) });
});

// Update status and/or courier + tracking number.
// Cancelling returns stock; a cancelled order can't be reopened (stock may already be sold again).
router.patch('/:id', async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_order' });
    const status = req.body?.status === undefined ? null : str(req.body.status);
    if (status !== null && !STATUSES.includes(status)) return res.status(400).json({ error: 'invalid_status' });
    const courier = req.body?.courier === undefined ? null : str(req.body.courier).slice(0, 60);
    const tracking = req.body?.trackingNumber === undefined ? null : str(req.body.trackingNumber).slice(0, 80);

    let changedStatus = null;
    let trackingAdded = false;
    const outcome = await withTransaction(async (client) => {
        const { rows } = await client.query('SELECT status, payment_method, tracking_number FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (!rows[0]) return { status: 404, body: { error: 'order_not_found' } };
        const current = rows[0].status;
        changedStatus = status && status !== current ? status : null;
        trackingAdded = tracking !== null && tracking !== rows[0].tracking_number && tracking !== '';
        if (status && status !== current) {
            if (current === 'cancelled') return { status: 409, body: { error: 'order_cancelled' } };
            if (status === 'cancelled') await releaseOrder(client, req.params.id);
        }
        // Cash on delivery is collected when the courier delivers (or when the owner marks it paid).
        const codCollected = rows[0].payment_method === 'cod' && ['paid', 'completed'].includes(status);
        await client.query(
            `UPDATE orders SET status = coalesce($2, status), courier = coalesce($3, courier),
                    tracking_number = coalesce($4, tracking_number),
                    payment_status = CASE WHEN $5 THEN 'paid' ELSE payment_status END,
                    paid_at = CASE WHEN $5 AND paid_at IS NULL THEN now() ELSE paid_at END,
                    updated_at = now()
             WHERE id = $1`,
            [req.params.id, status, courier, tracking, codCollected],
        );
        return null;
    });
    if (outcome) return res.status(outcome.status).json(outcome.body);
    // Tell the customer about status changes (and tracking numbers added to a shipped order).
    const fresh = await loadOrder(req.params.id);
    if (changedStatus || (trackingAdded && fresh.status === 'shipped')) await emailOrderStatus(fresh, req);
    const [order] = await loadAdminOrders('WHERE o.id = $1', [req.params.id]);
    res.json({ order });
});

// ---------- Returns & exchanges ----------
router.get('/returns', async (_req, res) => {
    const { rows } = await query(
        `SELECT r.*, o.customer_email, o.customer_name, o.total
         FROM return_requests r JOIN orders o ON o.id = r.order_id
         ORDER BY (r.status = 'requested') DESC, r.created_at DESC LIMIT 500`,
    );
    res.json({
        returns: rows.map((r) => ({
            id: r.id, orderId: r.order_id, kind: r.kind, reason: r.reason, details: r.details,
            status: r.status, adminNote: r.admin_note, customerEmail: r.customer_email,
            customerName: r.customer_name, orderTotal: r.total, createdAt: r.created_at, updatedAt: r.updated_at,
        })),
    });
});

router.patch('/returns/:id', async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_return' });
    const status = str(req.body?.status);
    if (!RETURN_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid_status' });
    const note = str(req.body?.adminNote).slice(0, 500);
    const { rows } = await query(
        `UPDATE return_requests r SET status = $2, admin_note = $3, updated_at = now()
         FROM orders o WHERE r.id = $1 AND o.id = r.order_id
         RETURNING r.kind, r.order_id, r.status, r.admin_note, o.customer_email`,
        [req.params.id, status, note],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'return_not_found' });
    const r = rows[0];
    try {
        await sendEmail({ to: r.customer_email, ...returnUpdateEmail({ kind: r.kind, orderId: r.order_id, status: r.status, adminNote: r.admin_note }, baseUrl(req)) });
    } catch (err) { console.error('[notify] return email failed:', err.message); }
    res.json({ ok: true });
});

// ---------- CSV export (one row per order line) ----------
const csvCell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');

router.get('/export.csv', async (_req, res) => {
    const { rows } = await query(
        `SELECT o.id, o.created_at, o.status, o.customer_name, o.customer_email, o.contact_phone, o.shipping_address,
                o.subtotal, o.bundle_discount, o.discount, o.discount_code, o.shipping_fee, o.total, o.courier, o.tracking_number,
                oi.title, oi.size, oi.color, oi.quantity, oi.unit_price, oi.unit_cost, oi.line_total, oi.is_preorder
         FROM orders o JOIN order_items oi ON oi.order_id = o.id
         ORDER BY o.created_at DESC, oi.id`,
    );
    const addr = (a) => (a ? [a.line1, a.line2, a.city, a.province, a.postalCode, a.country].filter(Boolean).join(', ') : '');
    const csv = toCsv(
        ['order_id', 'date', 'status', 'customer', 'email', 'phone', 'address', 'item', 'size', 'color', 'qty', 'unit_price',
            'unit_cost', 'line_total', 'preorder', 'order_subtotal', 'bundle_discount', 'discount', 'discount_code',
            'shipping_fee', 'order_total', 'courier', 'tracking_number'],
        rows.map((r) => [r.id, new Date(r.created_at).toISOString(), r.status, r.customer_name, r.customer_email, r.contact_phone,
            addr(r.shipping_address), r.title, r.size, r.color, r.quantity, r.unit_price, r.unit_cost, r.line_total,
            r.is_preorder ? 'yes' : 'no', r.subtotal, r.bundle_discount, r.discount, r.discount_code, r.shipping_fee, r.total,
            r.courier, r.tracking_number]),
    );
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="paradigm-orders.csv"' });
    res.send(`\uFEFF${csv}`); // BOM so Excel reads ₱ and accents correctly
});

export default router;
