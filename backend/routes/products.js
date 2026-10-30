import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

const LIST_SQL = `
    SELECT p.id, p.title, p.description, p.price, i.sha256
    FROM products p
    LEFT JOIN product_images i ON i.product_id = p.id
    WHERE p.is_active
    ORDER BY p.sort_order, p.id`;

const ONE_SQL = `
    SELECT p.id, p.title, p.description, p.price, i.sha256
    FROM products p
    LEFT JOIN product_images i ON i.product_id = p.id
    WHERE p.is_active AND p.id = $1`;

const IMAGE_SQL = `
    SELECT i.mime_type, i.data, i.sha256
    FROM product_images i
    JOIN products p ON p.id = i.product_id
    WHERE p.is_active AND i.product_id = $1`;

// Image URLs carry a content hash so browsers can cache them forever;
// re-seeding a changed image produces a new URL.
function toDto(row) {
    return {
        id: row.id,
        title: row.title,
        desc: row.description,
        price: row.price,
        image: row.sha256 ? `/api/products/${row.id}/image?v=${row.sha256.slice(0, 16)}` : null,
    };
}

function parseId(raw) {
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 && id <= 2_147_483_647 ? id : null;
}

router.get('/', async (_req, res) => {
    const { rows } = await query(LIST_SQL);
    // Short CDN cache so admin edits (next batch) show up within a minute.
    res.set('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
    res.json(rows.map(toDto));
});

router.get('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid product id' });

    const { rows } = await query(ONE_SQL, [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Product not found' });

    res.json(toDto(rows[0]));
});

router.get('/:id/image', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid product id' });

    const { rows } = await query(IMAGE_SQL, [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Image not found' });

    const { mime_type: mimeType, data, sha256 } = rows[0];
    const versioned = req.query.v === sha256.slice(0, 16);

    res.set({
        'Content-Type': mimeType,
        ETag: `"${sha256}"`,
        'Cache-Control': versioned ? 'public, max-age=31536000, s-maxage=31536000, immutable' : 'public, max-age=300',
    });
    // res.send() answers 304 automatically when If-None-Match matches the ETag.
    res.send(data);
});

export default router;
