// Cart pricing used by both the checkout quote (read-only) and order placement.
// Prices, stock, discounts and shipping always come from the database, never from the browser.
import { SIZE_ORDER } from './catalog.js';
import { str } from './validation.js';

const MAX_LINES = 50;
const MAX_QUANTITY = 99;
export const round2 = (n) => Math.round(n * 100) / 100;

// Parses [{ id, size, color, quantity }] and merges duplicate lines. Returns { lines } or { error }.
export function parseCartItems(raw) {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_LINES) return { error: 'invalid_items' };
    const merged = new Map();
    for (const item of raw) {
        const id = Number(item?.id);
        const quantity = Number(item?.quantity);
        const size = str(item?.size).toUpperCase();
        const color = str(item?.color).slice(0, 40);
        if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
            return { error: 'invalid_items' };
        }
        if (!SIZE_ORDER.includes(size)) return { error: 'size_required' };
        const key = `${id}|${color}|${size}`;
        const prev = merged.get(key);
        merged.set(key, { id, size, color, quantity: Math.min(MAX_QUANTITY, (prev?.quantity ?? 0) + quantity) });
    }
    return { lines: [...merged.values()] };
}

// Computes the full quote. With { lock: true } (inside a transaction) the variant rows and the
// discount code are locked FOR UPDATE so two checkouts can't oversell or overuse a code.
export async function buildQuote(db, lines, { discountCode = '', settings, lock = false }) {
    const forUpdate = lock ? 'FOR UPDATE OF v' : '';
    const { rows } = await db.query(
        `SELECT v.product_id, v.color, v.size, v.stock,
                p.title, p.price, p.cost, p.is_active, p.allow_preorder, p.release_at
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
         JOIN unnest($1::int[], $2::text[], $3::text[]) AS k(pid, color, size)
              ON v.product_id = k.pid AND v.color = k.color AND v.size = k.size
         ${forUpdate}`,
        [lines.map((l) => l.id), lines.map((l) => l.color), lines.map((l) => l.size)],
    );
    const byKey = new Map(rows.map((r) => [`${r.product_id}|${r.color}|${r.size}`, r]));
    const now = Date.now();

    const priced = [];
    const problems = [];
    for (const line of lines) {
        const v = byKey.get(`${line.id}|${line.color}|${line.size}`);
        if (!v || !v.is_active) {
            problems.push({ ...line, problem: 'unavailable' });
            continue;
        }
        if (v.release_at && new Date(v.release_at).getTime() > now) {
            problems.push({ ...line, title: v.title, problem: 'not_released', releaseAt: v.release_at });
            continue;
        }
        const inStock = v.stock >= line.quantity;
        if (!inStock && !v.allow_preorder) {
            problems.push({ ...line, title: v.title, problem: 'out_of_stock', available: v.stock });
            continue;
        }
        priced.push({
            productId: line.id,
            title: v.title,
            size: line.size,
            color: line.color,
            quantity: line.quantity,
            unitPrice: v.price,
            unitCost: v.cost,
            lineTotal: round2(v.price * line.quantity),
            isPreorder: !inStock,
            stock: v.stock,
        });
    }

    const subtotal = round2(priced.reduce((s, l) => s + l.lineTotal, 0));
    const itemCount = priced.reduce((s, l) => s + l.quantity, 0);

    let bundleDiscount = 0;
    if (settings.bundleMinQty > 0 && settings.bundlePercent > 0 && itemCount >= settings.bundleMinQty) {
        bundleDiscount = round2((subtotal * settings.bundlePercent) / 100);
    }
    const afterBundle = round2(subtotal - bundleDiscount);

    let discount = 0;
    let codeError = null;
    let appliedCode = null;
    const code = str(discountCode).toUpperCase().slice(0, 40);
    if (code) {
        const { rows: codes } = await db.query(
            `SELECT * FROM discount_codes WHERE code = $1 ${lock ? 'FOR UPDATE' : ''}`,
            [code],
        );
        const c = codes[0];
        if (!c || !c.is_active) codeError = 'invalid_code';
        else if (c.expires_at && new Date(c.expires_at).getTime() < now) codeError = 'code_expired';
        else if (c.max_uses !== null && c.used_count >= c.max_uses) codeError = 'code_used_up';
        else if (afterBundle < c.min_subtotal) codeError = 'code_minimum_not_met';
        else {
            discount = c.kind === 'percent'
                ? round2((afterBundle * Math.min(100, c.value)) / 100)
                : round2(Math.min(c.value, afterBundle));
            appliedCode = c.code;
        }
        if (codeError && c) codeError = { error: codeError, minSubtotal: c.min_subtotal };
        else if (codeError) codeError = { error: codeError };
    }

    const merchandise = round2(afterBundle - discount);
    const freeShipping = settings.freeShippingMin > 0 && merchandise >= settings.freeShippingMin;
    const shippingFee = priced.length === 0 || freeShipping ? 0 : settings.shippingFee;
    const total = round2(merchandise + shippingFee);

    return {
        lines: priced,
        problems,
        itemCount,
        subtotal,
        bundleDiscount,
        discount,
        discountCode: appliedCode,
        codeError,
        shippingFee,
        freeShippingRemaining: settings.freeShippingMin > 0 && !freeShipping
            ? round2(settings.freeShippingMin - merchandise) : 0,
        total,
    };
}

// Puts stock back for an order's in-stock lines (pre-orders never took stock) and
// returns its discount-code use. Call inside a transaction.
export async function releaseOrder(db, orderId) {
    await db.query(
        `UPDATE product_variants v SET stock = v.stock + oi.quantity
         FROM order_items oi
         WHERE oi.order_id = $1 AND NOT oi.is_preorder
           AND v.product_id = oi.product_id AND v.color = oi.color AND v.size = oi.size`,
        [orderId],
    );
    await db.query(
        `UPDATE discount_codes SET used_count = greatest(used_count - 1, 0)
         WHERE code = (SELECT discount_code FROM orders WHERE id = $1)`,
        [orderId],
    );
}
