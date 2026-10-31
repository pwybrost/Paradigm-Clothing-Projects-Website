// PayMongo Hosted Checkout (GCash, Maya, cards...). Customers pay on PayMongo's page; we never see card data.
// Docs: https://docs.paymongo.com/docs/payment-channels-hosted-checkout
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const API = 'https://api.paymongo.com/v1';

async function call(method, path, body) {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: {
            Authorization: `Basic ${Buffer.from(`${config.paymongoSecretKey}:`).toString('base64')}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const detail = data?.errors?.map((e) => e.detail).join('; ') || `HTTP ${res.status}`;
        throw new Error(`PayMongo: ${detail}`);
    }
    return data.data;
}

// One line for the whole order so discounts and shipping always match our total exactly.
export async function createCheckoutSession(order, base) {
    const amount = Math.round(Number(order.total) * 100); // centavos
    const items = order.items.map((i) => `${i.title} (${i.size}) x${i.quantity}`).join(', ');
    const session = await call('POST', '/checkout_sessions', {
        data: {
            attributes: {
                line_items: [{ name: `Paradigm Order #${order.id}`, description: items.slice(0, 250), amount, currency: 'PHP', quantity: 1 }],
                payment_method_types: config.paymongoMethods,
                description: `Paradigm Order #${order.id}`,
                reference_number: String(order.id),
                send_email_receipt: true,
                show_description: true,
                show_line_items: true,
                success_url: `${base}/Orders.html?paid=${order.id}`,
                cancel_url: `${base}/Orders.html?payment=cancelled&order=${order.id}`,
                billing: {
                    name: order.shippingAddress?.name || order.customerName,
                    email: order.customerEmail,
                    phone: order.contactPhone || undefined,
                },
                metadata: { order_id: String(order.id) },
            },
        },
    });
    return { id: session.id, url: session.attributes.checkout_url };
}

export const getCheckoutSession = (id) => call('GET', `/checkout_sessions/${encodeURIComponent(id)}`);

export async function expireCheckoutSession(id) {
    try {
        await call('POST', `/checkout_sessions/${encodeURIComponent(id)}/expire`);
    } catch (err) {
        console.warn('[paymongo] expire failed (may already be paid/expired):', err.message);
    }
}

// Returns { paid, reference } for a checkout session resource.
export function sessionPayment(session) {
    const payments = session?.attributes?.payments ?? [];
    const paid = payments.find((p) => p?.attributes?.status === 'paid');
    const intentPaid = session?.attributes?.payment_intent?.attributes?.status === 'succeeded';
    return { paid: Boolean(paid || intentPaid), reference: paid?.id ?? session?.attributes?.payment_intent?.id ?? null };
}

// Paymongo-Signature: "t=<timestamp>,te=<test sig>,li=<live sig>"; sig = HMAC-SHA256(secret, `${t}.${rawBody}`).
export function verifyWebhook(rawBody, header) {
    if (!config.paymongoWebhookSecret || !header) return false;
    const parts = Object.fromEntries(String(header).split(',').map((kv) => kv.split('=').map((s) => s.trim())));
    if (!parts.t) return false;
    // Reject events older than 10 minutes (replay protection).
    if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 600) return false;
    const expected = createHmac('sha256', config.paymongoWebhookSecret).update(`${parts.t}.${rawBody}`).digest('hex');
    const given = parts.li || parts.te || '';
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    return a.length === b.length && timingSafeEqual(a, b);
}
