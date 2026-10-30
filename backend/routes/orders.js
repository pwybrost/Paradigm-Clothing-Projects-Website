import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import { loadUser, requireAuth } from '../lib/session.js';

const router = Router();
const MAX_LINES = 50;
const MAX_QUANTITY = 99;

router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});
router.use(loadUser, requireAuth);

const round2 = (n) => Math.round(n * 100) / 100;

function toOrderDto(order, items) {
    return {
        id: order.id,
        status: order.status,
        itemCount: order.item_count,
        total: order.total,
        createdAt: order.created_at,
        updatedAt: order.updated_at,
        items: items.map((i) => ({
            productId: i.product_id,
            title: i.title,
            unitPrice: i.unit_price,
            quantity: i.quantity,
            lineTotal: i.line_total,
        })),
    };
}

// Place an order. The client only sends product ids and quantities;
// prices always come from the database.
router.post('/', async (req, res) => {
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!rawItems || rawItems.length === 0 || rawItems.length > MAX_LINES) {
        return res.status(400).json({ error: 'invalid_items' });
    }

    const quantities = new Map();
    for (const item of rawItems) {
        const id = Number(item?.id);
        const qty = Number(item?.quantity);
        if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
            return res.status(400).json({ error: 'invalid_items' });
        }
        quantities.set(id, Math.min(MAX_QUANTITY, (quantities.get(id) ?? 0) + qty));
    }

    const ids = [...quantities.keys()];
    const { rows: products } = await query(
        'SELECT id, title, price, cost FROM products WHERE is_active AND id = ANY($1::int[])',
        [ids],
    );
    if (products.length !== ids.length) return res.status(409).json({ error: 'product_unavailable' });

    const lines = products.map((p) => {
        const quantity = quantities.get(p.id);
        return { productId: p.id, title: p.title, unitPrice: p.price, unitCost: p.cost, quantity, lineTotal: round2(p.price * quantity) };
    });
    const total = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));
    const itemCount = lines.reduce((sum, l) => sum + l.quantity, 0);

    const order = await withTransaction(async (client) => {
        const { rows } = await client.query(
            `INSERT INTO orders (user_id, customer_email, customer_name, item_count, total)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [req.user.id, req.user.email, req.user.username, itemCount, total],
        );
        const created = rows[0];
        const items = [];
        for (const l of lines) {
            const { rows: itemRows } = await client.query(
                `INSERT INTO order_items (order_id, product_id, title, unit_price, unit_cost, quantity, line_total)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [created.id, l.productId, l.title, l.unitPrice, l.unitCost, l.quantity, l.lineTotal],
            );
            items.push(itemRows[0]);
        }
        return toOrderDto(created, items);
    });

    res.status(201).json({ order });
});

// The signed-in user's own orders (newest first), used by My Orders / History in the next batch.
router.get('/mine', async (req, res) => {
    const { rows: orders } = await query(
        'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200',
        [req.user.id],
    );
    if (orders.length === 0) return res.json({ orders: [] });

    const { rows: items } = await query(
        'SELECT * FROM order_items WHERE order_id = ANY($1::bigint[]) ORDER BY id',
        [orders.map((o) => o.id)],
    );
    const byOrder = Map.groupBy(items, (i) => String(i.order_id));
    res.json({ orders: orders.map((o) => toOrderDto(o, byOrder.get(String(o.id)) ?? [])) });
});

// Customers can cancel their own order while it's still pending (not yet paid or shipped).
router.post('/:id/cancel', async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_order' });
    const { rows } = await query(
        `UPDATE orders SET status = 'cancelled', updated_at = now()
         WHERE id = $1 AND user_id = $2 AND status = 'pending'
         RETURNING *`,
        [req.params.id, req.user.id],
    );
    if (rows.length === 0) {
        const exists = await query('SELECT status FROM orders WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
        if (exists.rowCount === 0) return res.status(404).json({ error: 'order_not_found' });
        return res.status(409).json({ error: 'order_not_cancellable', status: exists.rows[0].status });
    }
    const { rows: items } = await query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [rows[0].id]);
    res.json({ order: toOrderDto(rows[0], items) });
});

export default router;
