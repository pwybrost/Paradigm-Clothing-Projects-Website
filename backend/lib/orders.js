// Shared order loading/serialisation, plus emails and payment state changes.
import { baseUrl, config, paymentsEnabled } from '../config.js';
import { query, withTransaction } from '../db.js';
import {
    newOrderOwnerEmail, orderConfirmationEmail, orderStatusEmail, sendEmail,
} from './email.js';
import { expireCheckoutSession, getCheckoutSession, sessionPayment } from './paymongo.js';
import { releaseOrder } from './pricing.js';

export function toOrderDto(order, items, returns = []) {
    return {
        id: order.id,
        status: order.status,
        itemCount: order.item_count,
        subtotal: order.subtotal ?? order.total,
        bundleDiscount: order.bundle_discount ?? 0,
        discount: order.discount ?? 0,
        discountCode: order.discount_code ?? null,
        shippingFee: order.shipping_fee ?? 0,
        total: order.total,
        shippingAddress: order.shipping_address ?? null,
        contactPhone: order.contact_phone ?? '',
        paymentMethod: order.payment_method ?? 'cod',
        paymentStatus: order.payment_status ?? 'unpaid',
        paidAt: order.paid_at ?? null,
        notes: order.notes ?? '',
        courier: order.courier ?? '',
        trackingNumber: order.tracking_number ?? '',
        customerName: order.customer_name,
        customerEmail: order.customer_email,
        createdAt: order.created_at,
        updatedAt: order.updated_at,
        items: items.map((i) => ({
            productId: i.product_id,
            title: i.title,
            size: i.size ?? '',
            color: i.color ?? '',
            isPreorder: i.is_preorder ?? false,
            unitPrice: i.unit_price,
            quantity: i.quantity,
            lineTotal: i.line_total,
        })),
        returns: returns.map((r) => ({
            id: r.id, kind: r.kind, reason: r.reason, details: r.details,
            status: r.status, adminNote: r.admin_note, createdAt: r.created_at, updatedAt: r.updated_at,
        })),
    };
}

export async function loadOrders(whereSql, params) {
    const { rows: orders } = await query(`SELECT * FROM orders ${whereSql}`, params);
    if (orders.length === 0) return [];
    const ids = orders.map((o) => o.id);
    const [{ rows: items }, { rows: returns }] = await Promise.all([
        query('SELECT * FROM order_items WHERE order_id = ANY($1::bigint[]) ORDER BY id', [ids]),
        query('SELECT * FROM return_requests WHERE order_id = ANY($1::bigint[]) ORDER BY created_at DESC', [ids]),
    ]);
    const itemsBy = Map.groupBy(items, (i) => String(i.order_id));
    const returnsBy = Map.groupBy(returns, (r) => String(r.order_id));
    return orders.map((o) => toOrderDto(o, itemsBy.get(String(o.id)) ?? [], returnsBy.get(String(o.id)) ?? []));
}

export async function loadOrder(id) {
    const [order] = await loadOrders('WHERE id = $1', [id]);
    return order ?? null;
}

// ---------- Emails (failures are logged, never block the request) ----------
const safe = async (fn) => { try { await fn(); } catch (err) { console.error('[notify]', err.message); } };

export const emailOrderPlaced = (order, req) => safe(async () => {
    const base = baseUrl(req);
    await sendEmail({ to: order.customerEmail, ...orderConfirmationEmail(order, base) });
    if (config.adminEmails.length) await sendEmail({ to: config.adminEmails, ...newOrderOwnerEmail(order, base) });
});

export const emailOrderStatus = (order, req) => safe(() => sendEmail({ to: order.customerEmail, ...orderStatusEmail(order, baseUrl(req)) }));

// ---------- Payments ----------
// Marks an online order paid (idempotent). Returns the order if it changed.
export async function markOrderPaid(orderId, reference) {
    const { rows } = await query(
        `UPDATE orders SET payment_status = 'paid', paid_at = now(), payment_reference = coalesce($2, payment_reference),
                status = CASE WHEN status = 'pending' THEN 'paid' ELSE status END, updated_at = now()
         WHERE id = $1 AND payment_status <> 'paid' AND status <> 'cancelled'
         RETURNING id`,
        [orderId, reference],
    );
    return rows[0] ? loadOrder(orderId) : null;
}

// Checks PayMongo directly (used when the customer returns, in case the webhook is late).
export async function syncPayment(order) {
    if (!paymentsEnabled() || order.paymentMethod !== 'online' || order.paymentStatus === 'paid') return null;
    const { rows } = await query('SELECT payment_session_id FROM orders WHERE id = $1', [order.id]);
    const sessionId = rows[0]?.payment_session_id;
    if (!sessionId) return null;
    const { paid, reference } = sessionPayment(await getCheckoutSession(sessionId));
    return paid ? markOrderPaid(order.id, reference) : null;
}

// Cancels online orders that weren't paid within the window and returns their stock.
// Runs lazily on checkout/order views and from the daily Vercel cron.
export async function expireUnpaidOrders() {
    const { rows } = await query(
        `SELECT id, payment_session_id FROM orders
         WHERE payment_status = 'awaiting' AND status = 'pending'
           AND coalesce(payment_started_at, created_at) < now() - make_interval(mins => $1::int)
         LIMIT 50`,
        [config.paymentExpiryMinutes],
    );
    let expired = 0;
    for (const o of rows) {
        // Last check with PayMongo so a payment made at the last minute isn't cancelled.
        if (paymentsEnabled() && o.payment_session_id) {
            try {
                const { paid, reference } = sessionPayment(await getCheckoutSession(o.payment_session_id));
                if (paid) { await markOrderPaid(o.id, reference); continue; }
            } catch (err) {
                console.warn('[payments] could not check session before expiring:', err.message);
                continue;
            }
        }
        const changed = await withTransaction(async (client) => {
            const { rowCount } = await client.query(
                `UPDATE orders SET status = 'cancelled', payment_status = 'expired', updated_at = now()
                 WHERE id = $1 AND payment_status = 'awaiting' AND status = 'pending'`,
                [o.id],
            );
            if (rowCount) await releaseOrder(client, o.id);
            return rowCount > 0;
        });
        if (changed) {
            expired++;
            if (o.payment_session_id && paymentsEnabled()) await expireCheckoutSession(o.payment_session_id);
        }
    }
    return expired;
}

let lastExpiryRun = 0;
// Throttled so it runs at most once a minute per function instance.
export function maybeExpireUnpaidOrders() {
    if (Date.now() - lastExpiryRun < 60_000) return Promise.resolve(0);
    lastExpiryRun = Date.now();
    return expireUnpaidOrders().catch((err) => { console.error('[payments] expiry failed:', err.message); return 0; });
}
