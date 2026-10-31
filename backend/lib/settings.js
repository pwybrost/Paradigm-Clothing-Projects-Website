// Store-wide settings, editable by the owner. Stored as one JSON row; missing keys use these defaults.
import { query } from '../db.js';
import { str } from './validation.js';

export const DEFAULT_SETTINGS = {
    shippingFee: 150,          // ₱ flat fee per order
    freeShippingMin: 2000,     // ₱ subtotal (after discounts) for free shipping; 0 = never free
    bundleMinQty: 0,           // items in cart to unlock the bundle deal; 0 = off
    bundlePercent: 0,          // % off the subtotal when the bundle deal applies
    announcement: '',          // banner text on the archive ('' = hidden)
    announcementUntil: null,   // ISO date: shows a countdown in the banner
    lowStockThreshold: 3,      // owner console warns at or below this stock
    social: { instagram: '', tiktok: '', facebook: '' },
};

export async function getSettings(db = { query }) {
    const { rows } = await db.query("SELECT value FROM store_settings WHERE key = 'store'");
    const saved = rows[0]?.value ?? {};
    return { ...DEFAULT_SETTINGS, ...saved, social: { ...DEFAULT_SETTINGS.social, ...(saved.social ?? {}) } };
}

const money = (v, max) => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : null;
};
const int = (v, max) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
};
const safeUrl = (v) => {
    const s = str(v);
    if (!s) return '';
    try {
        const u = new URL(s);
        return u.protocol === 'https:' ? u.href.slice(0, 200) : null;
    } catch {
        return null;
    }
};

// Validates a partial update and returns { settings } or { error }.
export function mergeSettings(current, body) {
    const next = structuredClone(current);
    if (body.shippingFee !== undefined) {
        if ((next.shippingFee = money(body.shippingFee, 100_000)) === null) return { error: 'invalid_shipping_fee' };
    }
    if (body.freeShippingMin !== undefined) {
        if ((next.freeShippingMin = money(body.freeShippingMin, 10_000_000)) === null) return { error: 'invalid_free_shipping_min' };
    }
    if (body.bundleMinQty !== undefined) {
        if ((next.bundleMinQty = int(body.bundleMinQty, 99)) === null) return { error: 'invalid_bundle_qty' };
    }
    if (body.bundlePercent !== undefined) {
        if ((next.bundlePercent = money(body.bundlePercent, 90)) === null) return { error: 'invalid_bundle_percent' };
    }
    if (body.lowStockThreshold !== undefined) {
        if ((next.lowStockThreshold = int(body.lowStockThreshold, 1000)) === null) return { error: 'invalid_low_stock' };
    }
    if (body.announcement !== undefined) next.announcement = str(body.announcement).slice(0, 160);
    if (body.announcementUntil !== undefined) {
        if (!body.announcementUntil) next.announcementUntil = null;
        else {
            const d = new Date(body.announcementUntil);
            if (Number.isNaN(d.getTime())) return { error: 'invalid_announcement_date' };
            next.announcementUntil = d.toISOString();
        }
    }
    if (body.social && typeof body.social === 'object') {
        for (const key of Object.keys(DEFAULT_SETTINGS.social)) {
            if (body.social[key] === undefined) continue;
            const url = safeUrl(body.social[key]);
            if (url === null) return { error: `invalid_${key}_url` };
            next.social[key] = url;
        }
    }
    return { settings: next };
}

export async function saveSettings(settings) {
    await query(
        `INSERT INTO store_settings (key, value) VALUES ('store', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [settings],
    );
}

// The subset anyone can see.
export function publicSettings(s) {
    return {
        shippingFee: s.shippingFee,
        freeShippingMin: s.freeShippingMin,
        bundleMinQty: s.bundleMinQty,
        bundlePercent: s.bundlePercent,
        announcement: s.announcement,
        announcementUntil: s.announcementUntil,
        social: s.social,
    };
}
