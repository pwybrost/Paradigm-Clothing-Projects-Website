// Email via the Resend HTTP API (no SDK needed). If RESEND_API_KEY / EMAIL_FROM aren't set,
// sending is skipped and logged, so the shop keeps working without email.
import { createHmac } from 'node:crypto';
import { config, emailEnabled } from '../config.js';

const API = 'https://api.resend.com';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const peso = (n) => `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function call(path, body) {
    if (!emailEnabled()) {
        console.warn(`[email] skipped (RESEND_API_KEY / EMAIL_FROM not set): ${Array.isArray(body) ? `${body.length} emails` : body.subject}`);
        return { skipped: true };
    }
    try {
        const res = await fetch(`${API}${path}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            console.error(`[email] Resend ${res.status}:`, data?.message || data);
            return { ok: false, error: data?.message || `HTTP ${res.status}` };
        }
        return { ok: true, data };
    } catch (err) {
        console.error('[email] send failed:', err.message);
        return { ok: false, error: err.message };
    }
}

// Paradigm-styled wrapper (dark, monospace labels, blue accent), with a plain-text version.
function layout({ title, intro, bodyHtml = '', button, footer = '' }) {
    return `<!DOCTYPE html><html><body style="margin:0;background:#000;padding:30px 12px;font-family:'Helvetica Neue',Arial,sans-serif;color:#fff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#080808;border:1px solid #333">
<tr><td style="padding:32px 32px 10px;text-align:center">
  <div style="font-size:26px;font-weight:300;letter-spacing:10px;text-transform:uppercase">PARADIGM</div>
  <div style="font-family:monospace;font-size:10px;letter-spacing:4px;color:#666;text-transform:uppercase;margin-top:4px">Clothing Projects</div>
</td></tr>
<tr><td style="padding:20px 32px 6px">
  <div style="font-size:15px;letter-spacing:4px;text-transform:uppercase;margin-bottom:14px">${esc(title)}</div>
  <div style="font-size:13px;line-height:1.8;color:#bbb">${intro}</div>
</td></tr>
<tr><td style="padding:6px 32px">${bodyHtml}</td></tr>
${button ? `<tr><td style="padding:18px 32px 8px;text-align:center"><a href="${esc(button.url)}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;font-family:monospace;font-size:11px;letter-spacing:3px;text-transform:uppercase;padding:14px 26px">${esc(button.label)}</a>
<div style="font-family:monospace;font-size:10px;color:#555;margin-top:12px;word-break:break-all">${esc(button.url)}</div></td></tr>` : ''}
<tr><td style="padding:24px 32px 30px;text-align:center;font-family:monospace;font-size:9px;letter-spacing:2px;color:#555;text-transform:uppercase;line-height:1.8">${footer || 'Paradigm Clothing Projects · All Rights Reserved'}</td></tr>
</table></td></tr></table></body></html>`;
}

const textVersion = (title, lines) => [`PARADIGM · ${title}`, '', ...lines.filter((l) => l !== null && l !== undefined)].join('\n');

export async function sendEmail({ to, subject, html, text, replyTo, headers }) {
    return call('/emails', {
        from: config.emailFrom,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        text,
        ...(replyTo || config.emailReplyTo ? { reply_to: replyTo || config.emailReplyTo } : {}),
        ...(headers ? { headers } : {}),
    });
}

// Up to 100 per Resend batch call.
export async function sendBatch(messages) {
    let sent = 0;
    const errors = [];
    for (let i = 0; i < messages.length; i += 100) {
        const chunk = messages.slice(i, i + 100).map((m) => ({
            from: config.emailFrom, to: [m.to], subject: m.subject, html: m.html, text: m.text,
            ...(config.emailReplyTo ? { reply_to: config.emailReplyTo } : {}),
            ...(m.headers ? { headers: m.headers } : {}),
        }));
        const r = await call('/emails/batch', chunk);
        if (r.skipped) return { skipped: true, sent: 0 };
        if (r.ok) sent += chunk.length; else errors.push(r.error);
    }
    return { sent, errors };
}

// ---------- Unsubscribe links ----------
export const unsubscribeToken = (email) => createHmac('sha256', config.appSecret).update(`unsub:${email.toLowerCase()}`).digest('hex').slice(0, 32);
export const unsubscribeUrl = (base, email) => `${base}/api/store/unsubscribe?email=${encodeURIComponent(email)}&token=${unsubscribeToken(email)}`;

// ---------- Templates ----------
function itemsTable(order) {
    const rows = order.items.map((i) => `<tr>
        <td style="padding:8px 0;border-bottom:1px solid #1a1a1a;font-size:12px;color:#ddd">${esc(i.title)}<br><span style="font-family:monospace;font-size:10px;color:#666">${esc(i.size)}${i.color ? ` · ${esc(i.color)}` : ''} × ${i.quantity}${i.isPreorder ? ' · PRE-ORDER' : ''}</span></td>
        <td style="padding:8px 0;border-bottom:1px solid #1a1a1a;font-family:monospace;font-size:12px;color:#3b82f6;text-align:right">${peso(i.lineTotal)}</td></tr>`).join('');
    const line = (label, value) => `<tr><td style="padding:4px 0;font-family:monospace;font-size:11px;color:#888">${label}</td><td style="padding:4px 0;font-family:monospace;font-size:11px;color:#aaa;text-align:right">${value}</td></tr>`;
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 4px">${rows}
        ${line('SUBTOTAL', peso(order.subtotal))}
        ${order.bundleDiscount ? line('BUNDLE DEAL', `−${peso(order.bundleDiscount)}`) : ''}
        ${order.discount ? line(`CODE ${esc(order.discountCode || '')}`, `−${peso(order.discount)}`) : ''}
        ${line('SHIPPING', order.shippingFee ? peso(order.shippingFee) : 'FREE')}
        <tr><td style="padding:10px 0 0;border-top:1px solid #333;font-family:monospace;font-size:13px;color:#fff">TOTAL</td><td style="padding:10px 0 0;border-top:1px solid #333;font-family:monospace;font-size:14px;color:#3b82f6;text-align:right">${peso(order.total)}</td></tr>
    </table>`;
}
const address = (a) => (a ? [a.name, a.line1, a.line2, a.city, a.province, a.postalCode, a.country].filter(Boolean).map(esc).join(', ') : '');
const payLabel = (o) => (o.paymentMethod === 'online' ? (o.paymentStatus === 'paid' ? 'Paid online' : 'Online payment (awaiting)') : 'Cash on Delivery');

export function orderConfirmationEmail(order, base) {
    const awaiting = order.paymentMethod === 'online' && order.paymentStatus !== 'paid';
    return {
        subject: `Order #${order.id} received · Paradigm`,
        html: layout({
            title: `Order #${order.id} received`,
            intro: awaiting
                ? 'Your order is reserved. Complete the online payment to confirm it. Unpaid orders are released after 2 hours.'
                : `Thanks for shopping Paradigm. ${order.paymentMethod === 'cod' ? 'Please prepare the exact amount for the courier.' : 'Your payment was received.'}`,
            bodyHtml: `${itemsTable(order)}<p style="font-size:11px;color:#888;line-height:1.7;margin-top:14px">SHIP TO: ${address(order.shippingAddress)}<br>PAYMENT: ${payLabel(order)}</p>`,
            button: { label: 'View My Orders', url: `${base}/Orders.html` },
        }),
        text: textVersion(`Order #${order.id} received`, [
            ...order.items.map((i) => `${i.title} (${i.size}) x${i.quantity}: ${peso(i.lineTotal)}`),
            `Total: ${peso(order.total)}`, `Payment: ${payLabel(order)}`, '', `${base}/Orders.html`,
        ]),
    };
}

export function paymentReceivedEmail(order, base) {
    return {
        subject: `Payment received for order #${order.id} · Paradigm`,
        html: layout({
            title: 'Payment received',
            intro: `We received ${peso(order.total)} for order <b style="color:#3b82f6">#${esc(order.id)}</b>. We'll email you again when it ships.`,
            button: { label: 'View Receipt', url: `${base}/Receipt.html?order=${order.id}` },
        }),
        text: textVersion('Payment received', [`Order #${order.id}: ${peso(order.total)} paid.`, `${base}/Receipt.html?order=${order.id}`]),
    };
}

const STATUS_COPY = {
    paid: ['Order confirmed', 'Your order is confirmed and being prepared.'],
    shipped: ['Your order has shipped', 'Your parcel is on its way.'],
    completed: ['Order delivered', 'Your order is marked as delivered. Enjoy, and let us know what you think with a review.'],
    cancelled: ['Order cancelled', 'Your order has been cancelled. If this is unexpected, reply to this email.'],
};

export function orderStatusEmail(order, base) {
    const [title, intro] = STATUS_COPY[order.status] ?? ['Order update', `Your order status is now ${order.status}.`];
    const tracking = order.trackingNumber
        ? `<p style="font-family:monospace;font-size:12px;color:#3b82f6;letter-spacing:1px">${esc(order.courier || 'Courier')} · TRACKING ${esc(order.trackingNumber)}</p>` : '';
    return {
        subject: `${title} · Order #${order.id}`,
        html: layout({ title, intro: `${intro} <br>Order <b style="color:#3b82f6">#${esc(order.id)}</b>`, bodyHtml: tracking, button: { label: 'Track Order', url: `${base}/Orders.html` } }),
        text: textVersion(title, [intro, `Order #${order.id}`, order.trackingNumber ? `${order.courier || 'Courier'} tracking: ${order.trackingNumber}` : null, `${base}/Orders.html`]),
    };
}

export function returnUpdateEmail(ret, base) {
    return {
        subject: `Your ${ret.kind} request for order #${ret.orderId}: ${ret.status}`,
        html: layout({
            title: `${ret.kind} request ${ret.status}`,
            intro: `Your ${esc(ret.kind)} request for order <b style="color:#3b82f6">#${esc(ret.orderId)}</b> is now <b>${esc(ret.status)}</b>.${ret.adminNote ? `<br><br>"${esc(ret.adminNote)}"` : ''}`,
            button: { label: 'View Order', url: `${base}/Orders.html` },
        }),
        text: textVersion(`${ret.kind} request ${ret.status}`, [`Order #${ret.orderId}`, ret.adminNote || null, `${base}/Orders.html`]),
    };
}

export function verifyEmail(name, url) {
    return {
        subject: 'Verify your Paradigm email',
        html: layout({ title: 'Verify your email', intro: `Hi ${esc(name)}, confirm this email address to finish setting up your profile. The link expires in 24 hours.`, button: { label: 'Verify Email', url } }),
        text: textVersion('Verify your email', [`Hi ${name}, confirm your email (expires in 24 hours):`, url]),
    };
}

export function resetEmail(name, url) {
    return {
        subject: 'Reset your Paradigm passcode',
        html: layout({ title: 'Reset your passcode', intro: `Hi ${esc(name)}, someone asked to reset the passcode for this account. If it was you, use the button below within 1 hour. If not, ignore this email; your passcode stays the same.`, button: { label: 'Set New Passcode', url } }),
        text: textVersion('Reset your passcode', [`Hi ${name}, reset your passcode within 1 hour:`, url, 'If you did not ask for this, ignore this email.']),
    };
}

export function phoneChangeEmail(name, phone, url) {
    return {
        subject: 'Confirm your new Paradigm phone number',
        html: layout({ title: 'Confirm phone change', intro: `Hi ${esc(name)}, confirm changing your cellphone number to <b style="color:#3b82f6">${esc(phone)}</b>. The link expires in 1 hour. If you didn't request this, ignore this email and consider changing your passcode.`, button: { label: 'Confirm New Number', url } }),
        text: textVersion('Confirm phone change', [`Confirm changing your number to ${phone} (expires in 1 hour):`, url]),
    };
}

export function restockEmail(product, size, base) {
    const url = `${base}/index.html?item=${product.id}`;
    return {
        subject: `${product.title}${size ? ` (${size})` : ''} is back · Paradigm`,
        html: layout({ title: 'Back in stock', intro: `<b style="color:#3b82f6">${esc(product.title)}</b>${size ? ` in size ${esc(size)}` : ''} is available again. Stock is limited, so grab it before it's gone.`, button: { label: 'Shop Now', url } }),
        text: textVersion('Back in stock', [`${product.title}${size ? ` (${size})` : ''} is back.`, url]),
    };
}

export function newOrderOwnerEmail(order, base) {
    return {
        subject: `New order #${order.id} · ${peso(order.total)} · ${payLabel(order)}`,
        html: layout({ title: `New order #${order.id}`, intro: `${esc(order.customerName)} (${esc(order.customerEmail)})`, bodyHtml: itemsTable(order), button: { label: 'Open Orders Menu', url: `${base}/index.html` } }),
        text: textVersion(`New order #${order.id}`, [`${order.customerName} <${order.customerEmail}>`, `Total ${peso(order.total)}`]),
    };
}

export function replyEmail(subject, message) {
    const html = esc(message).replace(/\n/g, '<br>');
    return {
        subject,
        html: layout({ title: subject, intro: html }),
        text: textVersion(subject, [message]),
    };
}

export function newsletterEmail(subject, message, unsubUrl) {
    return {
        subject,
        html: layout({
            title: subject,
            intro: esc(message).replace(/\n/g, '<br>'),
            button: { label: 'Shop the Archive', url: unsubUrl.replace(/\/api\/store\/unsubscribe.*$/, '/index.html') },
            footer: `You subscribed at Paradigm. <a href="${esc(unsubUrl)}" style="color:#888">Unsubscribe</a>`,
        }),
        text: textVersion(subject, [message, '', `Unsubscribe: ${unsubUrl}`]),
        headers: { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    };
}
