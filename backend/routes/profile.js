import { Router } from 'express';
import { query } from '../db.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import {
    NAME_CHANGE_DAYS, destroyOtherSessions, fetchUser, loadUser, requireAuth, toPublicUser,
} from '../lib/session.js';
import { PASSWORD_RE, PERSON_NAME_RE, SIZES, rawStr, sniffImageType, str } from '../lib/validation.js';

const router = Router();
const MAX_AVATAR_BYTES = 512 * 1024; // the browser resizes to 320x320 before uploading
const BIO_MAX = 160;
const DESCRIPTION_MAX = 1000;

router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});
router.use(loadUser, requireAuth);

async function respondWithProfile(req, res) {
    const user = await fetchUser(req.user.id);
    const { rows } = await query(
        `SELECT
            count(*) FILTER (WHERE status <> 'cancelled')::int                     AS order_count,
            coalesce(sum(total) FILTER (WHERE status <> 'cancelled'), 0)::numeric  AS total_spent,
            coalesce(sum(item_count) FILTER (WHERE status <> 'cancelled'), 0)::int AS items_bought,
            count(*) FILTER (WHERE status IN ('pending', 'paid', 'shipped'))::int  AS active_orders
         FROM orders WHERE user_id = $1`,
        [req.user.id],
    );
    const wish = await query('SELECT count(*)::int AS n FROM wishlist WHERE user_id = $1', [req.user.id]);
    const s = rows[0];
    res.json({
        user: toPublicUser(user),
        stats: {
            orderCount: s.order_count,
            totalSpent: s.total_spent,
            itemsBought: s.items_bought,
            activeOrders: s.active_orders,
            wishlistCount: wish.rows[0].n,
        },
    });
}

router.get('/', respondWithProfile);

// Bio, description, size preference and shipping address can be edited any time.
router.patch('/', async (req, res) => {
    const body = req.body ?? {};
    const bio = str(body.bio);
    const description = str(body.description);
    const sizePreference = str(body.sizePreference).toUpperCase();
    if (bio.length > BIO_MAX) return res.status(400).json({ error: 'bio_too_long' });
    if (description.length > DESCRIPTION_MAX) return res.status(400).json({ error: 'description_too_long' });
    if (!SIZES.includes(sizePreference)) return res.status(400).json({ error: 'invalid_size' });

    let address = null;
    if (body.shippingAddress && typeof body.shippingAddress === 'object') {
        const a = body.shippingAddress;
        address = {
            line1: str(a.line1).slice(0, 120),
            line2: str(a.line2).slice(0, 120),
            city: str(a.city).slice(0, 60),
            province: str(a.province).slice(0, 60),
            postalCode: str(a.postalCode).slice(0, 12),
            country: str(a.country).slice(0, 60),
        };
        if (!Object.values(address).some(Boolean)) address = null;
    }

    await query(
        `UPDATE users SET bio = $2, description = $3, size_preference = $4, shipping_address = $5, updated_at = now()
         WHERE id = $1`,
        [req.user.id, bio, description, sizePreference, address],
    );
    await respondWithProfile(req, res);
});

// First and last name: can only change once every 30 days (the first time is always allowed).
router.put('/name', async (req, res) => {
    const firstName = str(req.body?.firstName).replace(/\s+/g, ' ');
    const lastName = str(req.body?.lastName).replace(/\s+/g, ' ');
    if (!PERSON_NAME_RE.test(firstName) || !PERSON_NAME_RE.test(lastName)) {
        return res.status(400).json({ error: 'invalid_name' });
    }
    if (firstName === (req.user.first_name ?? '') && lastName === (req.user.last_name ?? '')) {
        return respondWithProfile(req, res);
    }

    // The 30-day check happens in the UPDATE itself so two quick requests can't both pass.
    const { rowCount } = await query(
        `UPDATE users SET first_name = $2, last_name = $3, name_changed_at = now(), updated_at = now()
         WHERE id = $1
           AND (name_changed_at IS NULL OR name_changed_at <= now() - make_interval(days => $4::int))`,
        [req.user.id, firstName, lastName, NAME_CHANGE_DAYS],
    );
    if (rowCount === 0) {
        const next = toPublicUser(req.user).nextNameChangeAt;
        return res.status(429).json({ error: 'name_change_locked', nextNameChangeAt: next });
    }
    await respondWithProfile(req, res);
});

// Profile picture: the browser sends a resized image as a data URL.
router.get('/avatar', async (req, res) => {
    const { rows } = await query('SELECT mime_type, data FROM user_avatars WHERE user_id = $1', [req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'no_avatar' });
    res.set({ 'Content-Type': rows[0].mime_type, 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.send(rows[0].data);
});

router.put('/avatar', async (req, res) => {
    const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(rawStr(req.body?.image));
    if (!match) return res.status(400).json({ error: 'invalid_image' });
    const data = Buffer.from(match[1], 'base64');
    if (data.length === 0 || data.length > MAX_AVATAR_BYTES) return res.status(413).json({ error: 'image_too_large' });
    const mimeType = sniffImageType(data);
    if (!mimeType) return res.status(400).json({ error: 'invalid_image' });

    await query(
        `INSERT INTO user_avatars (user_id, mime_type, data, byte_size) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET mime_type = EXCLUDED.mime_type, data = EXCLUDED.data,
            byte_size = EXCLUDED.byte_size, updated_at = now()`,
        [req.user.id, mimeType, data, data.length],
    );
    await respondWithProfile(req, res);
});

router.delete('/avatar', async (req, res) => {
    await query('DELETE FROM user_avatars WHERE user_id = $1', [req.user.id]);
    await respondWithProfile(req, res);
});

// Change passcode: needs the current one, then signs out every other device.
router.post('/password', async (req, res) => {
    const current = rawStr(req.body?.currentPassword);
    const next = rawStr(req.body?.newPassword);
    if (!PASSWORD_RE.test(next) || next.length > 200) return res.status(400).json({ error: 'weak_password' });
    if (!(await verifyPassword(current, req.user.password_hash))) {
        return res.status(401).json({ error: 'wrong_password' });
    }
    await query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [req.user.id, await hashPassword(next)]);
    const signedOut = await destroyOtherSessions(req, req.user.id);
    res.json({ ok: true, signedOut });
});

router.post('/logout-others', async (req, res) => {
    const signedOut = await destroyOtherSessions(req, req.user.id);
    res.json({ ok: true, signedOut });
});

export default router;
