// Product listing shared by the public API and the owner console.
import { query } from '../db.js';

export const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
const BEST_SELLER_COUNT = 3;

const productImage = (id, sha) => (sha ? `/api/products/${id}/image?v=${sha.slice(0, 16)}` : null);
// Card-sized version (about 520px) so the grid doesn't decode 19 full-size photos.
const productThumb = (id, sha, hasThumb) => (sha ? `/api/products/${id}/image?v=${sha.slice(0, 16)}${hasThumb ? '&size=card' : ''}` : null);
const galleryImage = (id, g) => `/api/products/${id}/gallery/${g.id}?v=${String(g.sha).slice(0, 16)}`;

const LIST_SQL = (where) => `
    SELECT p.*, i.sha256, (i.thumb IS NOT NULL) AS has_thumb,
        coalesce((SELECT json_agg(json_build_object('color', v.color, 'size', v.size, 'stock', v.stock)
                                  ORDER BY v.color, array_position($1::text[], v.size))
                  FROM product_variants v WHERE v.product_id = p.id), '[]') AS variants,
        coalesce((SELECT json_agg(json_build_object('id', g.id, 'sha', g.sha256) ORDER BY g.position, g.id)
                  FROM product_gallery g WHERE g.product_id = p.id), '[]') AS gallery,
        (SELECT round(avg(r.rating), 1) FROM reviews r WHERE r.product_id = p.id) AS rating,
        (SELECT count(*)::int FROM reviews r WHERE r.product_id = p.id) AS review_count,
        coalesce((SELECT sum(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                  WHERE oi.product_id = p.id AND o.status <> 'cancelled'
                    AND o.created_at > now() - interval '90 days'), 0)::int AS sold_recent
    FROM products p
    LEFT JOIN product_images i ON i.product_id = p.id
    ${where}
    ORDER BY p.sort_order, p.id`;

function toDto(row, { owner }) {
    const dto = {
        id: row.id,
        title: row.title,
        desc: row.description,
        price: row.price,
        compareAtPrice: row.compare_at_price && row.compare_at_price > row.price ? row.compare_at_price : null,
        category: row.category,
        image: productImage(row.id, row.sha256),
        thumb: productThumb(row.id, row.sha256, row.has_thumb),
        gallery: row.gallery.map((g) => galleryImage(row.id, g)),
        variants: row.variants,
        rating: row.rating,
        reviewCount: row.review_count,
        popularity: row.sold_recent,
        bestSeller: false,
        releaseAt: row.release_at,
        allowPreorder: row.allow_preorder,
        isLimited: row.is_limited,
        createdAt: row.created_at,
    };
    if (owner) {
        dto.cost = row.cost;
        dto.rawCompareAtPrice = row.compare_at_price;
        dto.isActive = row.is_active;
        dto.sortOrder = row.sort_order;
        dto.galleryIds = row.gallery.map((g) => g.id);
        dto.updatedAt = row.updated_at;
    }
    return dto;
}

export async function listProducts({ owner = false, id = null } = {}) {
    const conditions = [];
    const params = [SIZE_ORDER];
    if (!owner) conditions.push('p.is_active');
    if (id !== null) {
        params.push(id);
        conditions.push(`p.id = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await query(LIST_SQL(where), params);
    const products = rows.map((r) => toDto(r, { owner }));

    // Best sellers: the top items by units sold in the last 90 days.
    if (id === null) {
        [...products]
            .filter((p) => p.popularity > 0)
            .sort((a, b) => b.popularity - a.popularity)
            .slice(0, BEST_SELLER_COUNT)
            .forEach((p) => { p.bestSeller = true; });
    }
    return products;
}
