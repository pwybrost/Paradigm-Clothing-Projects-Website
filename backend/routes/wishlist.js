import { Router } from 'express';
import { query } from '../db.js';
import { loadUser, requireAuth } from '../lib/session.js';
import { parsePositiveInt } from '../lib/validation.js';

const router = Router();
const MAX_WISHLIST = 200;

router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});
router.use(loadUser, requireAuth);

async function listWishlist(userId) {
    const { rows } = await query(
        `SELECT p.id, p.title, p.description, p.price, i.sha256, w.created_at
         FROM wishlist w
         JOIN products p ON p.id = w.product_id AND p.is_active
         LEFT JOIN product_images i ON i.product_id = p.id
         WHERE w.user_id = $1
         ORDER BY w.created_at DESC`,
        [userId],
    );
    return rows.map((r) => ({
        id: r.id,
        title: r.title,
        desc: r.description,
        price: r.price,
        image: r.sha256 ? `/api/products/${r.id}/image?v=${r.sha256.slice(0, 16)}` : null,
        addedAt: r.created_at,
    }));
}

router.get('/', async (req, res) => {
    res.json({ items: await listWishlist(req.user.id) });
});

router.put('/:productId', async (req, res) => {
    const productId = parsePositiveInt(req.params.productId);
    if (!productId) return res.status(400).json({ error: 'invalid_product' });

    const { rows } = await query('SELECT count(*)::int AS n FROM wishlist WHERE user_id = $1', [req.user.id]);
    if (rows[0].n >= MAX_WISHLIST) return res.status(409).json({ error: 'wishlist_full' });

    const { rowCount } = await query(
        `INSERT INTO wishlist (user_id, product_id)
         SELECT $1::uuid, id FROM products WHERE id = $2::int AND is_active
         ON CONFLICT DO NOTHING`,
        [req.user.id, productId],
    );
    if (rowCount === 0) {
        const exists = await query('SELECT 1 FROM wishlist WHERE user_id = $1 AND product_id = $2', [req.user.id, productId]);
        if (exists.rowCount === 0) return res.status(404).json({ error: 'product_not_found' });
    }
    res.json({ ok: true });
});

router.delete('/:productId', async (req, res) => {
    const productId = parsePositiveInt(req.params.productId);
    if (!productId) return res.status(400).json({ error: 'invalid_product' });
    await query('DELETE FROM wishlist WHERE user_id = $1 AND product_id = $2', [req.user.id, productId]);
    res.json({ ok: true });
});

export default router;
