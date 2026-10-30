// Owner-only profit & loss tracker and expenses.
//
// Revenue counts orders that are paid, shipped or completed ("realized").
// Pending orders are reported separately; cancelled orders are ignored.
// Profit = revenue - cost of goods (unit_cost snapshot at purchase) - expenses.
import { Router } from 'express';
import { query } from '../../db.js';
import { str } from '../../lib/validation.js';

const router = Router();

const RANGES = {
    '7d': { days: 7, bucket: 'day' },
    '30d': { days: 30, bucket: 'day' },
    '90d': { days: 90, bucket: 'week' },
    '12m': { days: 365, bucket: 'month' },
    all: { days: null, bucket: 'month' },
};
const EXPENSE_CATEGORIES = ['production', 'shipping', 'packaging', 'marketing', 'platform', 'other'];
const REALIZED = `('paid', 'shipped', 'completed')`;

router.get('/pnl', async (req, res) => {
    const rangeKey = RANGES[req.query.range] ? req.query.range : '30d';
    const { days, bucket } = RANGES[rangeKey];
    // $1 = start timestamp or NULL for all time. bucket is from the fixed list above.
    const since = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;

    const [summary, pending, expenseTotal, series, expenseSeries, top, expenses] = await Promise.all([
        query(
            `SELECT count(DISTINCT o.id)::int AS orders,
                    coalesce(sum(oi.line_total), 0)::numeric AS revenue,
                    coalesce(sum(oi.unit_cost * oi.quantity), 0)::numeric AS cogs,
                    coalesce(sum(oi.quantity), 0)::int AS units
             FROM orders o JOIN order_items oi ON oi.order_id = o.id
             WHERE o.status IN ${REALIZED} AND ($1::timestamptz IS NULL OR o.created_at >= $1)`,
            [since],
        ),
        query(
            `SELECT count(*)::int AS orders, coalesce(sum(total), 0)::numeric AS amount
             FROM orders WHERE status = 'pending' AND ($1::timestamptz IS NULL OR created_at >= $1)`,
            [since],
        ),
        query(
            `SELECT coalesce(sum(amount), 0)::numeric AS amount FROM expenses
             WHERE ($1::timestamptz IS NULL OR spent_on >= $1::date)`,
            [since],
        ),
        query(
            `SELECT date_trunc('${bucket}', o.created_at) AS period,
                    sum(oi.line_total)::numeric AS revenue,
                    sum(oi.unit_cost * oi.quantity)::numeric AS cogs
             FROM orders o JOIN order_items oi ON oi.order_id = o.id
             WHERE o.status IN ${REALIZED} AND ($1::timestamptz IS NULL OR o.created_at >= $1)
             GROUP BY 1 ORDER BY 1`,
            [since],
        ),
        query(
            `SELECT date_trunc('${bucket}', spent_on::timestamptz) AS period, sum(amount)::numeric AS amount
             FROM expenses WHERE ($1::timestamptz IS NULL OR spent_on >= $1::date)
             GROUP BY 1 ORDER BY 1`,
            [since],
        ),
        query(
            `SELECT oi.product_id, oi.title, sum(oi.quantity)::int AS units,
                    sum(oi.line_total)::numeric AS revenue,
                    sum(oi.line_total - oi.unit_cost * oi.quantity)::numeric AS profit
             FROM orders o JOIN order_items oi ON oi.order_id = o.id
             WHERE o.status IN ${REALIZED} AND ($1::timestamptz IS NULL OR o.created_at >= $1)
             GROUP BY oi.product_id, oi.title ORDER BY revenue DESC LIMIT 10`,
            [since],
        ),
        query(
            `SELECT id, label, category, amount, spent_on FROM expenses
             WHERE ($1::timestamptz IS NULL OR spent_on >= $1::date)
             ORDER BY spent_on DESC, id DESC LIMIT 200`,
            [since],
        ),
    ]);

    const s = summary.rows[0];
    const expenseAmount = expenseTotal.rows[0].amount;
    const grossProfit = s.revenue - s.cogs;
    const netProfit = grossProfit - expenseAmount;

    // Merge sales and expense buckets into one timeline.
    const periods = new Map();
    const keyOf = (d) => new Date(d).toISOString();
    for (const r of series.rows) {
        periods.set(keyOf(r.period), { period: r.period, revenue: r.revenue, cogs: r.cogs, expenses: 0 });
    }
    for (const r of expenseSeries.rows) {
        const k = keyOf(r.period);
        const p = periods.get(k) ?? { period: r.period, revenue: 0, cogs: 0, expenses: 0 };
        p.expenses = r.amount;
        periods.set(k, p);
    }
    const timeline = [...periods.values()]
        .sort((a, b) => new Date(a.period) - new Date(b.period))
        .map((p) => ({ ...p, profit: p.revenue - p.cogs - p.expenses }));

    res.json({
        range: rangeKey,
        bucket,
        since,
        summary: {
            orders: s.orders,
            units: s.units,
            revenue: s.revenue,
            cogs: s.cogs,
            grossProfit,
            expenses: expenseAmount,
            netProfit,
            margin: s.revenue > 0 ? netProfit / s.revenue : null,
            pendingOrders: pending.rows[0].orders,
            pendingRevenue: pending.rows[0].amount,
        },
        timeline,
        topProducts: top.rows.map((r) => ({ productId: r.product_id, title: r.title, units: r.units, revenue: r.revenue, profit: r.profit })),
        expenses: expenses.rows.map((e) => ({ id: e.id, label: e.label, category: e.category, amount: e.amount, spentOn: e.spent_on })),
    });
});

router.post('/expenses', async (req, res) => {
    const label = str(req.body?.label);
    const category = EXPENSE_CATEGORIES.includes(str(req.body?.category)) ? str(req.body.category) : 'other';
    const amount = Number.parseFloat(req.body?.amount);
    const spentOn = /^\d{4}-\d{2}-\d{2}$/.test(str(req.body?.spentOn)) ? str(req.body.spentOn) : null;
    if (!label || label.length > 120) return res.status(400).json({ error: 'invalid_label' });
    if (!Number.isFinite(amount) || amount < 0 || amount > 100_000_000) return res.status(400).json({ error: 'invalid_amount' });

    const { rows } = await query(
        `INSERT INTO expenses (label, category, amount, spent_on, created_by)
         VALUES ($1, $2, $3, coalesce($4::date, CURRENT_DATE), $5) RETURNING id`,
        [label, category, Math.round(amount * 100) / 100, spentOn, req.user.id],
    );
    res.status(201).json({ id: rows[0].id });
});

router.delete('/expenses/:id', async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_expense' });
    const { rowCount } = await query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'expense_not_found' });
    res.json({ ok: true });
});

export default router;
