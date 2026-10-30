// Converts every product image in server/data/images to WebP and upserts
// products + image bytes into Neon PostgreSQL. Safe to re-run.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { products } from '../data/products.js';
import { closePool, getPool } from '../db.js';

const IMAGE_DIR = path.join(config.rootDir, 'server', 'data', 'images');
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
    const client = await getPool().connect();

    try {
        await client.query('BEGIN');

        for (const [index, product] of products.entries()) {
            const image = await convertImage(sharp, product.image);
            const sha256 = createHash('sha256').update(image.data).digest('hex');

            await client.query(
                `INSERT INTO products (id, slug, title, description, price, sort_order, is_active)
                 VALUES ($1, $2, $3, $4, $5, $6, TRUE)
                 ON CONFLICT (id) DO UPDATE SET
                    slug = EXCLUDED.slug,
                    title = EXCLUDED.title,
                    description = EXCLUDED.description,
                    price = EXCLUDED.price,
                    sort_order = EXCLUDED.sort_order,
                    is_active = TRUE,
                    updated_at = now()`,
                [product.id, product.slug, product.title, product.desc, product.price, index],
            );

            await client.query(
                `INSERT INTO product_images (product_id, mime_type, data, width, height, byte_size, sha256, original_filename)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (product_id) DO UPDATE SET
                    mime_type = EXCLUDED.mime_type,
                    data = EXCLUDED.data,
                    width = EXCLUDED.width,
                    height = EXCLUDED.height,
                    byte_size = EXCLUDED.byte_size,
                    sha256 = EXCLUDED.sha256,
                    original_filename = EXCLUDED.original_filename,
                    updated_at = now()`,
                [product.id, image.mimeType, image.data, image.width, image.height, image.data.length, sha256, product.image],
            );

            const kb = (n) => `${Math.round(n / 1024)} KB`;
            console.log(`[seed] ${product.id} ${product.title.padEnd(26)} ${kb(image.originalSize)} -> ${kb(image.data.length)} (${image.mimeType})`);
        }

        await client.query('COMMIT');
        console.log(`[seed] done: ${products.length} products stored in the database`);
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

seed()
    .catch((err) => {
        console.error('[seed] failed:', err.message);
        process.exitCode = 1;
    })
    .finally(closePool);
