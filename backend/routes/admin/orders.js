// Owner-only order management: every customer's orders, with status updates.
import { Router } from 'express';
import { query } from '../../db.js';
import { str } from '../../lib/validation.js';

const router = Router();
const STATUSES = ['pending', 'paid', 'shipped', 'completed', 'cancelled'];

function toDto(o, items) {
    return {
        id: o.id,
        status: o.status,
        itemCount: o.item_count,
        total: o.total,
        createdAt: o.created_at,
        updatedAt: o.updated_at,
        customer: {
            userId: o.user_id,
            email: o.customer_email,
            name: o.customer_name,
            fullName: [o.first_name, o.last_name].filter(Boolean).join(' ') || null,
            phone: o.phone ?? null,
            shippingAddress: o.shipping_address ?? null,
            accountDeleted: !o.user_id,
        },
        items: items.map((i) => ({
            productId: i.product_id,
            title: i.title,
            unitPrice: i.unit_price,
            unitCost: i.unit_cost,
            quantity: i.quantity,
            lineTotal: i.line_total,
        })),
    };
}

// Newest first; the frontend groups them by customer.
router.get('/', async (req, res) => {
    const status = str(req.query.status);
    const params = [];
    let where = '';
    if (STATUSES.includes(status)) {
        params.push(status);
        where = 'WHERE o.status = $1';
    }
    const { rows: orders } = await query(
        `SELECT o.*, u.first_name, u.last_name, u.phone, u.shipping_address
         FROM orders o LEFT JOIN users u ON u.id = o.user_id
         ${where}
         ORDER BY o.created_at DESC LIMIT 1000`,
        params,
    );
    if (orders.length === 0) return res.json({ orders: [] });

    const { rows: items } = await query(
        'SELECT * FROM order_items WHERE order_id = ANY($1::bigint[]) ORDER BY id',
        [orders.map((o) => o.id)],
    );
    const byOrder = Map.groupBy(items, (i) => String(i.order_id));
    res.json({ orders: orders.map((o) => toDto(o, byOrder.get(String(o.id)) ?? [])) });
});

router.patch('/:id/status', async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_order' });
    const status = str(req.body?.status);
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'invalid_status' });

    const { rows } = await query(
        `UPDATE orders SET status = $2, updated_at = now() WHERE id = $1 RETURNING id, status, updated_at`,
        [req.params.id, status],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'order_not_found' });
    res.json({ order: { id: rows[0].id, status: rows[0].status, updatedAt: rows[0].updated_at } });
});

export default router;
