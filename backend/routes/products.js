import { Router } from 'express';
import { query } from '../db.js';
import { listProducts, SIZE_ORDER } from '../lib/catalog.js';
import { loadUser, requireAuth } from '../lib/session.js';
import { parsePositiveInt, str } from '../lib/validation.js';

const router = Router();
const REVIEW_MAX = 1000;

const IMAGE_SQL = `
    SELECT i.mime_type, i.data, i.sha256
    FROM product_images i JOIN products p ON p.id = i.product_id
    WHERE p.is_active AND i.product_id = $1`;

const GALLERY_SQL = `
    SELECT g.mime_type, g.data, g.sha256
    FROM product_gallery g JOIN products p ON p.id = g.product_id
    WHERE p.is_active AND g.product_id = $1 AND g.id = $2`;

function sendImage(req, res, row) {
    const versioned = req.query.v === row.sha256.slice(0, 16);
    res.set({
        'Content-Type': row.mime_type,
        ETag: `"${row.sha256}"`,
        'Cache-Control': versioned ? 'public, max-age=31536000, s-maxage=31536000, immutable' : 'public, max-age=300',
    });
    res.send(row.data); // answers 304 automatically when If-None-Match matches
}

router.get('/', async (_req, res) => {
    // Short CDN cache so owner edits and stock changes show up within ~30s.
    res.set('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=30');
    res.json(await listProducts());
});

router.get('/:id', async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_product' });
    const [product] = await listProducts({ id });
    if (!product) return res.status(404).json({ error: 'product_not_found' });
    res.set('Cache-Control', 'public, max-age=0, s-maxage=30');
    res.json(product);
});

router.get('/:id/image', async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_product' });
    const { rows } = await query(IMAGE_SQL, [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'image_not_found' });
    sendImage(req, res, rows[0]);
});

router.get('/:id/gallery/:imageId', async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id || !/^\d{1,18}$/.test(req.params.imageId)) return res.status(400).json({ error: 'invalid_image' });
    const { rows } = await query(GALLERY_SQL, [id, req.params.imageId]);
    if (rows.length === 0) return res.status(404).json({ error: 'image_not_found' });
    sendImage(req, res, rows[0]);
});

// ---------- Reviews (verified purchases only) ----------
// "Bought" means an order containing the item that is paid, shipped or completed.
async function hasBought(userId, productId) {
    const { rowCount } = await query(
        `SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.user_id = $1 AND oi.product_id = $2 AND o.status IN ('paid', 'shipped', 'completed') LIMIT 1`,
        [userId, productId],
    );
    return rowCount > 0;
}

const reviewerName = (r) => {
    if (r.first_name) return `${r.first_name} ${r.last_name ? `${r.last_name[0]}.` : ''}`.trim();
    return r.username;
};

router.get('/:id/reviews', loadUser, async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_product' });
    res.set('Cache-Control', 'no-store');
    const { rows } = await query(
        `SELECT r.id, r.user_id, r.rating, r.body, r.created_at, r.updated_at, u.first_name, u.last_name, u.username
         FROM reviews r JOIN users u ON u.id = r.user_id
         WHERE r.product_id = $1 ORDER BY r.created_at DESC LIMIT 100`,
        [id],
    );
    const reviews = rows.map((r) => ({
        id: r.id, rating: r.rating, body: r.body, name: reviewerName(r),
        createdAt: r.created_at, edited: r.updated_at > r.created_at, mine: req.user?.id === r.user_id,
    }));
    const canReview = req.user ? await hasBought(req.user.id, id) : false;
    res.json({ reviews, canReview, signedIn: Boolean(req.user) });
});

router.put('/:id/reviews', loadUser, requireAuth, async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_product' });
    const rating = Number(req.body?.rating);
    const body = str(req.body?.body).slice(0, REVIEW_MAX);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'invalid_rating' });
    if (!(await hasBought(req.user.id, id))) return res.status(403).json({ error: 'purchase_required' });
    await query(
        `INSERT INTO reviews (product_id, user_id, rating, body) VALUES ($1, $2, $3, $4)
         ON CONFLICT (product_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, body = EXCLUDED.body, updated_at = now()`,
        [id, req.user.id, rating, body],
    );
    res.json({ ok: true });
});

router.delete('/:id/reviews', loadUser, requireAuth, async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_product' });
    await query('DELETE FROM reviews WHERE product_id = $1 AND user_id = $2', [id, req.user.id]);
    res.json({ ok: true });
});

// ---------- Restock alerts ----------
router.post('/:id/notify', loadUser, requireAuth, async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    const size = str(req.body?.size).toUpperCase();
    const color = str(req.body?.color).slice(0, 40);
    if (!id || (size && !SIZE_ORDER.includes(size))) return res.status(400).json({ error: 'invalid_request' });
    const { rowCount } = await query(
        `INSERT INTO restock_requests (product_id, user_id, size, color)
         SELECT id, $2, $3, $4 FROM products WHERE id = $1 AND is_active
         ON CONFLICT DO NOTHING`,
        [id, req.user.id, size, color],
    );
    res.set('Cache-Control', 'no-store').json({ ok: true, alreadyRequested: rowCount === 0 });
});

export default router;
