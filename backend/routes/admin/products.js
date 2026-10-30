// Owner-only catalogue management: create, edit, replace photo, delete (archived to deleted_products).
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { query, withTransaction } from '../../db.js';
import { parsePositiveInt, rawStr, sniffImageType, str } from '../../lib/validation.js';

const router = Router();
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024; // the browser resizes to max 1600px WebP before upload
const MAX_PRICE = 1_000_000;

const imageUrl = (id, sha) => (sha ? `/api/products/${id}/image?v=${sha.slice(0, 16)}` : null);

function toAdminDto(row) {
    return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        desc: row.description,
        price: row.price,
        cost: row.cost,
        sortOrder: row.sort_order,
        image: imageUrl(row.id, row.sha256),
        updatedAt: row.updated_at,
    };
}

const PRODUCT_SQL = `
    SELECT p.*, i.sha256 FROM products p
    LEFT JOIN product_images i ON i.product_id = p.id`;

function slugify(title, id) {
    const base = title.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 60);
    return `${base || 'item'}-${id}`;
}

function parseMoney(value) {
    const n = typeof value === 'number' ? value : Number.parseFloat(value);
    return Number.isFinite(n) && n >= 0 && n <= MAX_PRICE ? Math.round(n * 100) / 100 : null;
}

// Validates title/desc/price/cost. `partial` allows missing fields (PATCH).
function readFields(body, partial) {
    const out = {};
    if (!partial || body.title !== undefined) {
        const title = str(body.title);
        if (!title || title.length > 80) return { error: 'invalid_title' };
        out.title = title;
    }
    if (!partial || body.desc !== undefined) {
        const desc = str(body.desc);
        if (desc.length > 2000) return { error: 'invalid_description' };
        out.description = desc;
    }
    if (!partial || body.price !== undefined) {
        const price = parseMoney(body.price);
        if (price === null) return { error: 'invalid_price' };
        out.price = price;
    }
    if (body.cost !== undefined || !partial) {
        const cost = body.cost === undefined || body.cost === '' ? 0 : parseMoney(body.cost);
        if (cost === null) return { error: 'invalid_cost' };
        out.cost = cost;
    }
    return { fields: out };
}

function readImage(dataUrl) {
    const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(rawStr(dataUrl));
    if (!match) return { error: 'invalid_image' };
    const data = Buffer.from(match[1], 'base64');
    if (data.length === 0 || data.length > MAX_IMAGE_BYTES) return { error: 'image_too_large' };
    const mimeType = sniffImageType(data);
    if (!mimeType) return { error: 'invalid_image' };
    return { data, mimeType, sha256: createHash('sha256').update(data).digest('hex') };
}

async function saveImage(client, productId, image, fileName) {
    await client.query(
        `INSERT INTO product_images (product_id, mime_type, data, byte_size, sha256, original_filename)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (product_id) DO UPDATE SET mime_type = EXCLUDED.mime_type, data = EXCLUDED.data,
            width = NULL, height = NULL, byte_size = EXCLUDED.byte_size, sha256 = EXCLUDED.sha256,
            original_filename = EXCLUDED.original_filename, updated_at = now()`,
        [productId, image.mimeType, image.data, image.data.length, image.sha256, fileName],
    );
}

async function fetchProduct(client, id) {
    const { rows } = await client.query(`${PRODUCT_SQL} WHERE p.id = $1`, [id]);
    return rows[0] ? toAdminDto(rows[0]) : null;
}

// All active products with cost (never cached, unlike the public list).
router.get('/', async (_req, res) => {
    const { rows } = await query(`${PRODUCT_SQL} WHERE p.is_active ORDER BY p.sort_order, p.id`);
    res.json({ products: rows.map(toAdminDto) });
});

router.post('/', async (req, res) => {
    const { fields, error } = readFields(req.body ?? {}, false);
    if (error) return res.status(400).json({ error });
    const image = readImage(req.body?.image);
    if (image.error) return res.status(400).json({ error: image.error });

    const product = await withTransaction(async (client) => {
        // Lock so two simultaneous creates can't pick the same id. Ids of deleted products are never reused.
        await client.query('LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE');
        const { rows } = await client.query(
            `SELECT greatest(
                (SELECT coalesce(max(id), 900) FROM products),
                (SELECT coalesce(max(product_id), 900) FROM deleted_products)) + 1 AS id,
             (SELECT coalesce(min(sort_order), 0) - 1 FROM products) AS sort_order`,
        );
        const { id, sort_order: sortOrder } = rows[0];
        await client.query(
            `INSERT INTO products (id, slug, title, description, price, cost, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [id, slugify(fields.title, id), fields.title, fields.description, fields.price, fields.cost, sortOrder],
        );
        await saveImage(client, id, image, `admin-upload-${id}`);
        return fetchProduct(client, id);
    });
    res.status(201).json({ product });
});

router.patch('/:id', async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_product' });
    const { fields, error } = readFields(req.body ?? {}, true);
    if (error) return res.status(400).json({ error });
    const image = req.body?.image ? readImage(req.body.image) : null;
    if (image?.error) return res.status(400).json({ error: image.error });

    const product = await withTransaction(async (client) => {
        const keys = Object.keys(fields);
        if (keys.length) {
            const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
            const { rowCount } = await client.query(
                `UPDATE products SET ${sets}, updated_at = now() WHERE id = $1 AND is_active`,
                [id, ...keys.map((k) => fields[k])],
            );
            if (rowCount === 0) return null;
        } else {
            const { rowCount } = await client.query('SELECT 1 FROM products WHERE id = $1 AND is_active', [id]);
            if (rowCount === 0) return null;
        }
        if (image) await saveImage(client, id, image, `admin-upload-${id}`);
        return fetchProduct(client, id);
    });
    if (!product) return res.status(404).json({ error: 'product_not_found' });
    res.json({ product });
});

// Delete: copies the product (and its photo) into deleted_products first, then removes it.
router.delete('/:id', async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_product' });
    if (str(req.body?.confirm) !== 'DELETE') return res.status(400).json({ error: 'confirmation_required' });
    const reason = str(req.body?.reason).slice(0, 300);

    const archived = await withTransaction(async (client) => {
        const { rows } = await client.query(
            `SELECT p.*, i.mime_type, i.data, i.original_filename FROM products p
             LEFT JOIN product_images i ON i.product_id = p.id
             WHERE p.id = $1 FOR UPDATE OF p`,
            [id],
        );
        const row = rows[0];
        if (!row) return null;
        const { mime_type: mimeType, data, ...product } = row;
        const { rows: archivedRows } = await client.query(
            `INSERT INTO deleted_products (product_id, product_data, image_mime_type, image_data, deleted_by, reason)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, deleted_at`,
            [id, product, mimeType ?? null, data ?? null, req.user.id, reason],
        );
        await client.query('DELETE FROM products WHERE id = $1', [id]); // image + wishlist rows cascade
        return archivedRows[0];
    });
    if (!archived) return res.status(404).json({ error: 'product_not_found' });
    res.json({ ok: true, archiveId: archived.id, deletedAt: archived.deleted_at });
});

// Backend record of deleted products (no image bytes in the list).
router.get('/deleted', async (_req, res) => {
    const { rows } = await query(
        `SELECT d.id, d.product_id, d.product_data, d.reason, d.deleted_at, u.email AS deleted_by_email,
                d.image_data IS NOT NULL AS has_image
         FROM deleted_products d LEFT JOIN users u ON u.id = d.deleted_by
         ORDER BY d.deleted_at DESC LIMIT 500`,
    );
    res.json({
        deleted: rows.map((r) => ({
            archiveId: r.id,
            productId: r.product_id,
            title: r.product_data.title,
            description: r.product_data.description,
            price: Number(r.product_data.price),
            cost: Number(r.product_data.cost ?? 0),
            reason: r.reason,
            hasImage: r.has_image,
            deletedBy: r.deleted_by_email,
            deletedAt: r.deleted_at,
        })),
    });
});

export default router;
