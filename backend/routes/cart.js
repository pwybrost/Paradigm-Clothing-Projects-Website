// Saved cart per account, so it follows the customer across devices and survives cleared browsers.
// The browser keeps working offline from its local copy and syncs here when it can (last write wins).
import { Router } from 'express';
import { query } from '../db.js';
import { SIZE_ORDER } from '../lib/catalog.js';
import { loadUser, requireAuth } from '../lib/session.js';
import { str } from '../lib/validation.js';

const router = Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(loadUser, requireAuth);

function readItems(raw) {
    if (!Array.isArray(raw) || raw.length > 50) return null;
    const items = [];
    for (const i of raw) {
        const id = Number(i?.id);
        const quantity = Number(i?.quantity);
        const size = str(i?.size).toUpperCase();
        if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(quantity) || quantity < 1 || quantity > 99 || !SIZE_ORDER.includes(size)) return null;
        items.push({ id, size, color: str(i?.color).slice(0, 40), quantity });
    }
    return items;
}

router.get('/', async (req, res) => {
    const { rows } = await query('SELECT items, updated_at FROM carts WHERE user_id = $1', [req.user.id]);
    res.json({ items: rows[0]?.items ?? [], updatedAt: rows[0]?.updated_at ?? null });
});

// { items, updatedAt }: updatedAt is when the change happened in the browser (it may have been offline).
// Older changes than the saved cart are ignored, so a stale tab can't overwrite a newer cart.
router.put('/', async (req, res) => {
    const items = readItems(req.body?.items);
    if (!items) return res.status(400).json({ error: 'invalid_items' });
    const changedAt = new Date(req.body?.updatedAt ?? Date.now());
    const at = Number.isNaN(changedAt.getTime()) || changedAt.getTime() > Date.now() + 60_000 ? new Date() : changedAt;
    const { rows } = await query(
        `INSERT INTO carts (user_id, items, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET items = EXCLUDED.items, updated_at = EXCLUDED.updated_at
         WHERE carts.updated_at <= EXCLUDED.updated_at
         RETURNING updated_at`,
        [req.user.id, JSON.stringify(items), at],
    );
    res.json({ ok: true, applied: rows.length > 0 });
});

export default router;
