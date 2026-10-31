// Owner-only catalogue management.
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { query, withTransaction } from '../../db.js';
import { listProducts, SIZE_ORDER } from '../../lib/catalog.js';
import { parsePositiveInt, rawStr, sniffImageType, str } from '../../lib/validation.js';
import { baseUrl, emailEnabled } from '../../config.js';
import { restockEmail, sendBatch } from '../../lib/email.js';

// Emails customers who asked to be notified, for sizes that just went from 0 to in stock.
// Requests are only removed once an email was actually sent.
async function sendRestockAlerts(req, productId, before, after) {
    if (!emailEnabled()) return 0;
    const key = (v) => `${v.color.toLowerCase()}|${v.size}`;
    const old = new Map(before.map((v) => [key(v), v.stock]));
    const restocked = after.filter((v) => v.stock > 0 && (old.get(key(v)) ?? 0) === 0);
    if (!restocked.length) return 0;
    const { rows: [product] } = await query('SELECT id, title FROM products WHERE id = $1 AND is_active', [productId]);
    if (!product) return 0;
    const { rows } = await query(
        `SELECT r.user_id, r.size, r.color, u.email FROM restock_requests r JOIN users u ON u.id = r.user_id
         WHERE r.product_id = $1`,
        [productId],
    );
    const matches = rows.filter((r) => restocked.some((v) => (!r.size || r.size === v.size) && (!r.color || r.color.toLowerCase() === v.color.toLowerCase())));
    if (!matches.length) return 0;
    const base = baseUrl(req);
    const result = await sendBatch(matches.map((m) => ({ to: m.email, ...restockEmail(product, m.size, base) })));
    if (result.sent) {
        await query(
            `DELETE FROM restock_requests r USING unnest($2::uuid[], $3::text[], $4::text[]) AS k(uid, size, color)
             WHERE r.product_id = $1 AND r.user_id = k.uid AND r.size = k.size AND r.color = k.color`,
            [productId, matches.map((m) => m.user_id), matches.map((m) => m.size), matches.map((m) => m.color)],
        );
    }
    return result.sent ?? 0;
}

const router = Router();
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024; // the browser resizes to max 1600px WebP before upload
const MAX_PRICE = 1_000_000;
const MAX_GALLERY = 8;

function slugify(title, id) {
    const base = title.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 60);
    return `${base || 'item'}-${id}`;
}

function parseMoney(value) {
    const n = typeof value === 'number' ? value : Number.parseFloat(value);
    return Number.isFinite(n) && n >= 0 && n <= MAX_PRICE ? Math.round(n * 100) / 100 : null;
}

// Validates editable fields. `partial` allows missing fields (PATCH). Returns { fields } or { error }.
function readFields(body, partial) {
    const out = {};
    const has = (k) => !partial || body[k] !== undefined;
    if (has('title')) {
        const title = str(body.title);
        if (!title || title.length > 80) return { error: 'invalid_title' };
        out.title = title;
    }
    if (has('desc')) {
        const desc = str(body.desc);
        if (desc.length > 2000) return { error: 'invalid_description' };
        out.description = desc;
    }
    if (has('price')) {
        const price = parseMoney(body.price);
        if (price === null) return { error: 'invalid_price' };
        out.price = price;
    }
    if (has('cost')) {
        const cost = body.cost === undefined || body.cost === '' || body.cost === null ? 0 : parseMoney(body.cost);
        if (cost === null) return { error: 'invalid_cost' };
        out.cost = cost;
    }
    if (has('compareAtPrice')) {
        const v = body.compareAtPrice;
        const compare = v === undefined || v === '' || v === null || Number(v) === 0 ? null : parseMoney(v);
        if (compare === undefined || (v && compare === null)) return { error: 'invalid_compare_price' };
        out.compare_at_price = compare;
    }
    if (has('category')) {
        const category = str(body.category).replace(/\s+/g, ' ').slice(0, 40) || 'Originals';
        out.category = category;
    }
    if (has('releaseAt')) {
        if (!body.releaseAt) out.release_at = null;
        else {
            const d = new Date(body.releaseAt);
            if (Number.isNaN(d.getTime())) return { error: 'invalid_release_date' };
            out.release_at = d.toISOString();
        }
    }
    if (has('allowPreorder')) out.allow_preorder = body.allowPreorder === true;
    if (has('isLimited')) out.is_limited = body.isLimited === true;
    if (has('isActive')) out.is_active = body.isActive !== false;
    return { fields: out };
}

// [{ color, size, stock }] -> validated list (at least one size). Returns { variants } or { error }.
function readVariants(raw) {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) return { error: 'sizes_required' };
    const seen = new Set();
    const variants = [];
    for (const v of raw) {
        const size = str(v?.size).toUpperCase();
        const color = str(v?.color).replace(/\s+/g, ' ').slice(0, 40);
        const stock = Number(v?.stock);
        if (!SIZE_ORDER.includes(size)) return { error: 'invalid_size' };
        if (!Number.isInteger(stock) || stock < 0 || stock > 100_000) return { error: 'invalid_stock' };
        const key = `${color.toLowerCase()}|${size}`;
        if (seen.has(key)) continue;
        seen.add(key);
        variants.push({ color, size, stock });
    }
    return { variants };
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

// thumb: optional card-sized copy made in the browser (falls back to the full photo if missing).
async function saveImage(client, productId, image, thumb = null) {
    await client.query(
        `INSERT INTO product_images (product_id, mime_type, data, byte_size, sha256, original_filename, thumb, thumb_mime)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (product_id) DO UPDATE SET mime_type = EXCLUDED.mime_type, data = EXCLUDED.data,
            width = NULL, height = NULL, byte_size = EXCLUDED.byte_size, sha256 = EXCLUDED.sha256,
            original_filename = EXCLUDED.original_filename, thumb = EXCLUDED.thumb, thumb_mime = EXCLUDED.thumb_mime,
            updated_at = now()`,
        [productId, image.mimeType, image.data, image.data.length, image.sha256, `admin-upload-${productId}`,
            thumb?.data ?? null, thumb?.mimeType ?? null],
    );
}
const readThumb = (dataUrl) => {
    if (!dataUrl) return null;
    const t = readImage(dataUrl);
    return t.error || t.data.length > 400 * 1024 ? null : t;
};

async function saveVariants(client, productId, variants) {
    await client.query('DELETE FROM product_variants WHERE product_id = $1', [productId]);
    await client.query(
        `INSERT INTO product_variants (product_id, color, size, stock)
         SELECT $1::int, * FROM unnest($2::text[], $3::text[], $4::int[])`,
        [productId, variants.map((v) => v.color), variants.map((v) => v.size), variants.map((v) => v.stock)],
    );
}

async function respondProduct(res, id, status = 200) {
    const [product] = await listProducts({ owner: true, id });
    if (!product) return res.status(404).json({ error: 'product_not_found' });
    res.status(status).json({ product });
}

// All products including hidden ones, with costs and restock-request counts.
router.get('/', async (_req, res) => {
    const [products, restock] = await Promise.all([
        listProducts({ owner: true }),
        query('SELECT product_id, count(*)::int AS n FROM restock_requests GROUP BY product_id'),
    ]);
    const counts = new Map(restock.rows.map((r) => [r.product_id, r.n]));
    for (const p of products) p.restockRequests = counts.get(p.id) ?? 0;
    res.json({ products });
});

router.post('/', async (req, res) => {
    const { fields, error } = readFields(req.body ?? {}, false);
    if (error) return res.status(400).json({ error });
    const { variants, error: vError } = readVariants(req.body?.variants);
    if (vError) return res.status(400).json({ error: vError });
    const image = readImage(req.body?.image);
    if (image.error) return res.status(400).json({ error: image.error });

    const id = await withTransaction(async (client) => {
        // Lock so two simultaneous creates can't pick the same id. Ids of deleted products are never reused.
        await client.query('LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE');
        const { rows } = await client.query(
            `SELECT greatest(
                (SELECT coalesce(max(id), 900) FROM products),
                (SELECT coalesce(max(product_id), 900) FROM deleted_products)) + 1 AS id,
             (SELECT coalesce(min(sort_order), 0) - 1 FROM products) AS sort_order`,
        );
        const { id: newId, sort_order: sortOrder } = rows[0];
        const cols = ['id', 'slug', 'sort_order', ...Object.keys(fields)];
        const values = [newId, slugify(fields.title, newId), sortOrder, ...Object.values(fields)];
        await client.query(
            `INSERT INTO products (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
            values,
        );
        await saveImage(client, newId, image, readThumb(req.body?.thumb));
        await saveVariants(client, newId, variants);
        return newId;
    });
    await respondProduct(res, id, 201);
});

router.patch('/:id', async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_product' });
    const { fields, error } = readFields(req.body ?? {}, true);
    if (error) return res.status(400).json({ error });
    let variants = null;
    if (req.body?.variants !== undefined) {
        const parsed = readVariants(req.body.variants);
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        variants = parsed.variants;
    }
    const image = req.body?.image ? readImage(req.body.image) : null;
    if (image?.error) return res.status(400).json({ error: image.error });

    let previousVariants = [];
    const found = await withTransaction(async (client) => {
        const { rowCount } = await client.query('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [id]);
        if (rowCount === 0) return false;
        previousVariants = (await client.query('SELECT color, size, stock FROM product_variants WHERE product_id = $1', [id])).rows;
        const keys = Object.keys(fields);
        if (keys.length) {
            const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
            await client.query(`UPDATE products SET ${sets}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
        }
        if (image) await saveImage(client, id, image, readThumb(req.body?.thumb));
        if (variants) await saveVariants(client, id, variants);
        return true;
    });
    if (!found) return res.status(404).json({ error: 'product_not_found' });
    if (variants) {
        try {
            const sent = await sendRestockAlerts(req, id, previousVariants, variants);
            if (sent) res.set('X-Restock-Alerts', String(sent));
        } catch (err) { console.error('[restock] alerts failed:', err.message); }
    }
    await respondProduct(res, id);
});

// New grid order: { ids: [productId, ...] } from first to last.
router.post('/reorder', async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    if (ids.length === 0 || ids.length > 2000 || !ids.every((n) => Number.isInteger(n) && n > 0)) {
        return res.status(400).json({ error: 'invalid_order' });
    }
    await query(
        `UPDATE products p SET sort_order = k.pos, updated_at = now()
         FROM unnest($1::int[]) WITH ORDINALITY AS k(id, pos) WHERE p.id = k.id`,
        [ids],
    );
    res.json({ ok: true });
});

// Extra photos
router.post('/:id/gallery', async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_product' });
    const image = readImage(req.body?.image);
    if (image.error) return res.status(400).json({ error: image.error });
    const { rows } = await query(
        'SELECT (SELECT count(*)::int FROM product_gallery WHERE product_id = $1) AS n, EXISTS (SELECT 1 FROM products WHERE id = $1) AS ok',
        [id],
    );
    if (!rows[0].ok) return res.status(404).json({ error: 'product_not_found' });
    if (rows[0].n >= MAX_GALLERY) return res.status(409).json({ error: 'gallery_full' });
    await query(
        `INSERT INTO product_gallery (product_id, position, mime_type, data, byte_size, sha256)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, rows[0].n, image.mimeType, image.data, image.data.length, image.sha256],
    );
    await respondProduct(res, id, 201);
});

router.delete('/:id/gallery/:imageId', async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id || !/^\d{1,18}$/.test(req.params.imageId)) return res.status(400).json({ error: 'invalid_image' });
    await query('DELETE FROM product_gallery WHERE product_id = $1 AND id = $2', [id, req.params.imageId]);
    await respondProduct(res, id);
});

// Delete: copies the product (photo, extra photos, sizes) into deleted_products first, then removes it.
router.delete('/:id', async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid_product' });
    if (str(req.body?.confirm) !== 'DELETE') return res.status(400).json({ error: 'confirmation_required' });
    const reason = str(req.body?.reason).slice(0, 300);

    const archived = await withTransaction(async (client) => {
        const { rows } = await client.query(
            `SELECT p.*, i.mime_type, i.data FROM products p
             LEFT JOIN product_images i ON i.product_id = p.id
             WHERE p.id = $1 FOR UPDATE OF p`,
            [id],
        );
        const row = rows[0];
        if (!row) return null;
        const { mime_type: mimeType, data, ...product } = row;
        const [{ rows: variants }, { rows: gallery }] = await Promise.all([
            client.query('SELECT color, size, stock FROM product_variants WHERE product_id = $1', [id]),
            client.query('SELECT mime_type, encode(data, \'base64\') AS data FROM product_gallery WHERE product_id = $1 ORDER BY position, id', [id]),
        ]);
        const { rows: archivedRows } = await client.query(
            `INSERT INTO deleted_products (product_id, product_data, image_mime_type, image_data, gallery, deleted_by, reason)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, deleted_at`,
            [id, { ...product, variants }, mimeType ?? null, data ?? null, JSON.stringify(gallery), req.user.id, reason],
        );
        await client.query('DELETE FROM products WHERE id = $1', [id]); // images, sizes, wishlist, reviews cascade
        return archivedRows[0];
    });
    if (!archived) return res.status(404).json({ error: 'product_not_found' });
    res.json({ ok: true, archiveId: archived.id, deletedAt: archived.deleted_at });
});

router.get('/deleted', async (_req, res) => {
    const { rows } = await query(
        `SELECT d.id, d.product_id, d.product_data, d.reason, d.deleted_at, u.email AS deleted_by_email,
                d.image_data IS NOT NULL AS has_image, coalesce(jsonb_array_length(d.gallery), 0) AS extra_photos
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
            extraPhotos: r.extra_photos,
            deletedBy: r.deleted_by_email,
            deletedAt: r.deleted_at,
        })),
    });
});

// Who asked to be notified, per product.
router.get('/restock-requests', async (_req, res) => {
    const { rows } = await query(
        `SELECT r.product_id, p.title, r.size, r.color, r.created_at, u.email
         FROM restock_requests r JOIN products p ON p.id = r.product_id JOIN users u ON u.id = r.user_id
         ORDER BY p.title, r.created_at DESC LIMIT 2000`,
    );
    res.json({ requests: rows.map((r) => ({ productId: r.product_id, title: r.title, size: r.size, color: r.color, email: r.email, createdAt: r.created_at })) });
});

export default router;
