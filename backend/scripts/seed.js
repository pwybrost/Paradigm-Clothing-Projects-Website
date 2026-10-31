// Stores every product photo from backend/data/images in Neon (converted to WebP).
//
// Safe to run on every deploy:
//   - products/images that already exist are left untouched (admin edits are never overwritten)
//   - products the admin deleted (recorded in deleted_products) are never re-created
//   - the photo files on disk are only read, never modified
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { DEFAULT_SIZES, DEFAULT_STOCK, ORIGINAL_RELEASE, products } from '../data/products.js';
import { closePool, withTransaction } from '../db.js';

const IMAGE_DIR = path.join(config.backendDir, 'data', 'images');
const MAX_DIMENSION = 1600; // px; the largest on-screen use is the 2.5x zoom in the product modal
const WEBP_QUALITY = 90;
const ORIGINAL_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

async function loadSharp() {
    try {
        return (await import('sharp')).default;
    } catch {
        console.warn('[seed] sharp is not installed; storing original image files without conversion.');
        return null;
    }
}

async function convertImage(sharp, fileName) {
    const original = await readFile(path.join(IMAGE_DIR, fileName));

    if (!sharp) {
        const mimeType = ORIGINAL_MIME[path.extname(fileName).toLowerCase()];
        if (!mimeType) throw new Error(`Unsupported image type: ${fileName}`);
        return { data: original, mimeType, width: null, height: null, originalSize: original.length };
    }

    const { data, info } = await sharp(original)
        .rotate() // respect EXIF orientation
        .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY, effort: 5 })
        .toBuffer({ resolveWithObject: true });

    return { data, mimeType: 'image/webp', width: info.width, height: info.height, originalSize: original.length };
}

async function seed() {
    const sharp = await loadSharp();

    await withTransaction(async (client) => {
        const deleted = await client.query('SELECT DISTINCT product_id FROM deleted_products');
        const deletedIds = new Set(deleted.rows.map((r) => r.product_id));
        const existing = await client.query('SELECT product_id FROM product_images');
        const hasImage = new Set(existing.rows.map((r) => r.product_id));

        let added = 0;
        for (const [index, product] of products.entries()) {
            if (deletedIds.has(product.id)) {
                console.log(`[seed] ${product.id} skipped (deleted by admin)`);
                continue;
            }

            await client.query(
                `INSERT INTO products (id, slug, title, description, price, sort_order, category, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (id) DO NOTHING`,
                [product.id, product.slug, product.title, product.desc, product.price, index, product.category, ORIGINAL_RELEASE],
            );

            if (hasImage.has(product.id)) continue;

            const image = await convertImage(sharp, product.image);
            const sha256 = createHash('sha256').update(image.data).digest('hex');
            await client.query(
                `INSERT INTO product_images (product_id, mime_type, data, width, height, byte_size, sha256, original_filename)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (product_id) DO NOTHING`,
                [product.id, image.mimeType, image.data, image.width, image.height, image.data.length, sha256, product.image],
            );
            added++;
            const kb = (n) => `${Math.round(n / 1024)} KB`;
            console.log(`[seed] ${product.id} ${product.title.padEnd(26)} ${kb(image.originalSize)} -> ${kb(image.data.length)} (${image.mimeType})`);
        }
        // Every product needs at least one size to be orderable. Only fills products that have none.
        const variants = await client.query(
            `INSERT INTO product_variants (product_id, color, size, stock)
             SELECT p.id, '', s.size, $2::int FROM products p CROSS JOIN unnest($1::text[]) AS s(size)
             WHERE NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id)`,
            [DEFAULT_SIZES, DEFAULT_STOCK],
        );
        if (variants.rowCount) console.log(`[seed] added default sizes (${variants.rowCount} size rows)`);
        console.log(`[seed] done: ${added} new image(s) stored, ${products.length - added} already present or skipped`);
    });
}

if (!config.databaseUrl && process.argv.includes('--if-configured')) {
    console.warn('[seed] DATABASE_URL not set; skipping seed');
} else {
    seed()
        .catch((err) => {
            console.error('[seed] failed:', err.message);
            process.exitCode = 1;
        })
        .finally(closePool);
}
