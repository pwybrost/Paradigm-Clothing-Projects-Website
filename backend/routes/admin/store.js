// Owner-only: store settings, discount codes, customers, messages, newsletter, review moderation.
import { Router } from 'express';
import { query } from '../../db.js';
import { getSettings, mergeSettings, saveSettings } from '../../lib/settings.js';
import { str } from '../../lib/validation.js';
import { toCsv } from './orders.js';

const router = Router();

// ---------- Settings ----------
router.get('/settings', async (_req, res) => res.json({ settings: await getSettings() }));

router.put('/settings', async (req, res) => {
    const { settings, error } = mergeSettings(await getSettings(), req.body ?? {});
    if (error) return res.status(400).json({ error });
    await saveSettings(settings);
    res.json({ settings });
});

// ---------- Discount codes ----------
const codeDto = (c) => ({
    code: c.code, kind: c.kind, value: c.value, minSubtotal: c.min_subtotal, maxUses: c.max_uses,
    usedCount: c.used_count, expiresAt: c.expires_at, isActive: c.is_active, createdAt: c.created_at,
});

router.get('/discounts', async (_req, res) => {
    const { rows } = await query('SELECT * FROM discount_codes ORDER BY created_at DESC');
    res.json({ discounts: rows.map(codeDto) });
});

router.post('/discounts', async (req, res) => {
    const b = req.body ?? {};
    const code = str(b.code).toUpperCase();
    const kind = str(b.kind);
    const value = Number.parseFloat(b.value);
    const minSubtotal = b.minSubtotal ? Number.parseFloat(b.minSubtotal) : 0;
    const maxUses = b.maxUses ? Number(b.maxUses) : null;
    const expiresAt = b.expiresAt ? new Date(b.expiresAt) : null;
    if (!/^[A-Z0-9_-]{3,30}$/.test(code)) return res.status(400).json({ error: 'invalid_code' });
    if (!['percent', 'fixed'].includes(kind)) return res.status(400).json({ error: 'invalid_kind' });
    if (!Number.isFinite(value) || value <= 0 || (kind === 'percent' && value > 100) || value > 1_000_000) {
        return res.status(400).json({ error: 'invalid_value' });
    }
    if (!Number.isFinite(minSubtotal) || minSubtotal < 0) return res.status(400).json({ error: 'invalid_minimum' });
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) return res.status(400).json({ error: 'invalid_max_uses' });
    if (expiresAt && Number.isNaN(expiresAt.getTime())) return res.status(400).json({ error: 'invalid_expiry' });
    try {
        const { rows } = await query(
            `INSERT INTO discount_codes (code, kind, value, min_subtotal, max_uses, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [code, kind, Math.round(value * 100) / 100, Math.round(minSubtotal * 100) / 100, maxUses, expiresAt],
        );
        res.status(201).json({ discount: codeDto(rows[0]) });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'code_exists' });
        throw err;
    }
});

router.patch('/discounts/:code', async (req, res) => {
    const { rows } = await query(
        'UPDATE discount_codes SET is_active = $2 WHERE code = $1 RETURNING *',
        [str(req.params.code).toUpperCase(), req.body?.isActive === true],
    );
    if (!rows[0]) return res.status(404).json({ error: 'code_not_found' });
    res.json({ discount: codeDto(rows[0]) });
});

router.delete('/discounts/:code', async (req, res) => {
    await query('DELETE FROM discount_codes WHERE code = $1', [str(req.params.code).toUpperCase()]);
    res.json({ ok: true });
});

// ---------- Customers ----------
router.get('/customers', async (_req, res) => {
    const { rows } = await query(
        `SELECT u.id, u.email, u.username, u.first_name, u.last_name, u.phone, u.role, u.created_at,
                count(o.id) FILTER (WHERE o.status <> 'cancelled')::int AS orders,
                coalesce(sum(o.total) FILTER (WHERE o.status <> 'cancelled'), 0)::numeric AS spent,
                max(o.created_at) AS last_order,
                (SELECT count(*)::int FROM wishlist w WHERE w.user_id = u.id) AS wishlist
         FROM users u LEFT JOIN orders o ON o.user_id = u.id
         GROUP BY u.id ORDER BY spent DESC, u.created_at DESC LIMIT 2000`,
    );
    res.json({
        customers: rows.map((r) => ({
            id: r.id, email: r.email, username: r.username,
            fullName: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
            phone: r.phone, role: r.role, joinedAt: r.created_at, orders: r.orders, spent: r.spent,
            lastOrderAt: r.last_order, wishlist: r.wishlist,
        })),
    });
});

// ---------- Contact messages ----------
router.get('/messages', async (_req, res) => {
    const { rows } = await query('SELECT * FROM contact_messages ORDER BY is_read, created_at DESC LIMIT 500');
    res.json({
        messages: rows.map((m) => ({
            id: m.id, name: m.name, email: m.email, subject: m.subject, message: m.message,
            isRead: m.is_read, createdAt: m.created_at, fromAccount: Boolean(m.user_id),
        })),
    });
});

router.patch('/messages/:id', async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_message' });
    await query('UPDATE contact_messages SET is_read = $2 WHERE id = $1', [req.params.id, req.body?.isRead !== false]);
    res.json({ ok: true });
});

router.delete('/messages/:id', async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_message' });
    await query('DELETE FROM contact_messages WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
});

// ---------- Newsletter ----------
router.get('/subscribers', async (_req, res) => {
    const { rows } = await query('SELECT email, created_at FROM newsletter_subscribers ORDER BY created_at DESC LIMIT 5000');
    res.json({ subscribers: rows.map((r) => ({ email: r.email, createdAt: r.created_at })) });
});

router.get('/subscribers.csv', async (_req, res) => {
    const { rows } = await query('SELECT email, created_at FROM newsletter_subscribers ORDER BY created_at');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="paradigm-subscribers.csv"' });
    res.send(`\uFEFF${toCsv(['email', 'subscribed_at'], rows.map((r) => [r.email, new Date(r.created_at).toISOString()]))}`);
});

router.delete('/subscribers/:email', async (req, res) => {
    await query('DELETE FROM newsletter_subscribers WHERE email = $1', [str(req.params.email).toLowerCase()]);
    res.json({ ok: true });
});

// ---------- Review moderation ----------
router.delete('/reviews/:id', async (req, res) => {
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'invalid_review' });
    await query('DELETE FROM reviews WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
});

export default router;
