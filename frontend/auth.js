// Client for the Paradigm API. Accounts, passwords and sessions live in Neon;
// the browser only holds an HttpOnly session cookie that JavaScript can't read.

// Remove data the old version stored in localStorage (including plain-text passwords).
(function purgeLegacyStorage() {
    try {
        localStorage.removeItem('paradigm_session');
        localStorage.removeItem('paradigm_last_order');
        for (const key of Object.keys(localStorage)) {
            if (!key.includes('@')) continue;
            const value = JSON.parse(localStorage.getItem(key));
            if (value && typeof value === 'object' && 'password' in value) localStorage.removeItem(key);
        }
    } catch { /* storage unavailable or non-JSON value: nothing to clean */ }
})();

export async function api(path, { method = 'GET', body } = {}) {
    try {
        const res = await fetch(path, {
            method,
            credentials: 'same-origin',
            headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, data };
    } catch {
        return { ok: false, status: 0, data: { error: 'network_error' } };
    }
}

// Returns { success: true } or { success: false, error: 'email_taken' | 'invalid_email' | ... }
export async function signup(username, email, phone, password) {
    const { ok, data } = await api('/api/auth/signup', { method: 'POST', body: { username, email, phone, password } });
    return ok ? { success: true, verificationSent: Boolean(data.verificationSent) } : { success: false, error: data.error };
}

// Returns { success: true, user } or { success: false, error: 'invalid_credentials' | 'network_error' | ... }
export async function login(email, password) {
    const { ok, data } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
    if (ok) clearUserData();
    return ok ? { success: true, user: data.user } : { success: false, error: data.error };
}

// Resolves to the signed-in user ({ id, username, email, phone, role }) or null.
export async function getCurrentUser() {
    const { ok, data } = await api('/api/auth/me');
    return ok ? data.user : null;
}

// Permanently deletes the account. Needs the account's email and passcode.
export async function resetAccount(email, password) {
    const { ok, data } = await api('/api/auth/delete-account', { method: 'POST', body: { email, password } });
    return ok ? { success: true } : { success: false, error: data.error };
}

export async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    clearUserData();
    window.location.href = 'Login.html';
}

// Forget everything tied to the previous account on this device (offline copies + unsent actions).
export function clearUserData() {
    try { localStorage.removeItem(OUTBOX_KEY); localStorage.removeItem('paradigm_cart_ts'); } catch { /* ignore */ }
    navigator.serviceWorker?.controller?.postMessage({ type: 'clear-user-cache' });
}

// payload: { items: [{ id, size, color, quantity }], shipping, notes, discountCode, saveAddress }.
// Prices, stock, discounts and shipping are calculated by the server.
// payload.requestId makes retries safe: the server returns the same order instead of a duplicate.
// If the server/network is down, the order is kept on this device and sent automatically later.
export async function placeOrder(payload, cartSnapshot = []) {
    const r = await api('/api/orders', { method: 'POST', body: payload });
    if (retryable(r.status)) {
        enqueue({ path: '/api/orders', method: 'POST', body: payload, kind: 'order', label: 'Order', meta: { cart: cartSnapshot } });
        return { success: false, queued: true, error: 'queued' };
    }
    return r.ok ? { success: true, order: r.data.order, data: r.data } : { success: false, error: r.data.error, data: r.data };
}

export const quoteCart = (items, discountCode) => api('/api/orders/quote', { method: 'POST', body: { items, discountCode } });
export const getOrder = (id) => api(`/api/orders/${encodeURIComponent(id)}`);
export const requestReturn = (id, body) => api(`/api/orders/${encodeURIComponent(id)}/returns`, { method: 'POST', body });

// ---------- Profile ----------
export const getProfile = () => api('/api/profile');
export const updateProfile = (fields) => sendOrQueue('/api/profile', { method: 'PATCH', body: fields, dedupe: 'profile', label: 'Profile changes' });
export const updateName = (firstName, lastName) => api('/api/profile/name', { method: 'PUT', body: { firstName, lastName } });
export const uploadAvatar = (dataUrl) => api('/api/profile/avatar', { method: 'PUT', body: { image: dataUrl } });
export const deleteAvatar = () => api('/api/profile/avatar', { method: 'DELETE' });
export const changePassword = (currentPassword, newPassword) =>
    api('/api/profile/password', { method: 'POST', body: { currentPassword, newPassword } });
export const logoutOtherDevices = () => api('/api/profile/logout-others', { method: 'POST' });

// ---------- Orders ----------
export const getMyOrders = () => api('/api/orders/mine');
export const cancelOrder = (id) => api(`/api/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST' });

// ---------- Wishlist ----------
export const getWishlist = () => api('/api/wishlist');
export const addToWishlist = (productId) => sendOrQueue(`/api/wishlist/${productId}`, { method: 'PUT', dedupe: `wish:${productId}`, label: 'Wishlist' });
export const removeFromWishlist = (productId) => sendOrQueue(`/api/wishlist/${productId}`, { method: 'DELETE', dedupe: `wish:${productId}`, label: 'Wishlist' });

// ---------- Saved cart (per account, synced across devices) ----------
export const getServerCart = () => api('/api/cart');
export const syncCart = (items, updatedAt) => sendOrQueue('/api/cart', {
    method: 'PUT', body: { items: items.map(({ id, size, color, quantity }) => ({ id, size, color, quantity })), updatedAt }, dedupe: 'cart', label: 'Cart',
});

// ---------- Email links & payments ----------
export const forgotPassword = (email) => api('/api/auth/forgot', { method: 'POST', body: { email } });
export const resetPassword = (token, password) => api('/api/auth/reset', { method: 'POST', body: { token, password } });
export const confirmEmail = (token) => api('/api/auth/verify', { method: 'POST', body: { token } });
export const confirmPhone = (token) => api('/api/auth/confirm-phone', { method: 'POST', body: { token } });
export const resendVerification = () => api('/api/auth/resend-verification', { method: 'POST' });
export const requestPhoneChange = (phone) => api('/api/profile/phone', { method: 'POST', body: { phone } });
export const payOrder = (id) => api(`/api/orders/${encodeURIComponent(id)}/pay`, { method: 'POST' });
export const checkPayment = (id) => api(`/api/orders/${encodeURIComponent(id)}/payment`);

// ---------- Offline outbox ----------
// Actions that fail because the network or server is down (status 0 / 502 / 503 / 504) are stored
// on this device and replayed in order when the connection returns. Other errors are not retried.
const OUTBOX_KEY = 'paradigm_outbox';
const retryable = (status) => status === 0 || status === 502 || status === 503 || status === 504;

export function readOutbox() {
    try {
        const v = JSON.parse(localStorage.getItem(OUTBOX_KEY));
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}
function writeOutbox(list) {
    try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(list)); } catch { /* storage full */ }
    window.dispatchEvent(new CustomEvent('prdgm:outbox', { detail: { type: 'changed', count: list.length } }));
}
export const newRequestId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

function enqueue(entry) {
    // dedupe: only the latest action per key matters (e.g. heart then un-heart the same item).
    const list = entry.dedupe ? readOutbox().filter((e) => e.dedupe !== entry.dedupe) : readOutbox();
    list.push({ ...entry, id: newRequestId(), createdAt: Date.now() });
    writeOutbox(list.slice(-100));
}

export async function sendOrQueue(path, { method = 'POST', body, label = 'Action', dedupe, kind = 'action', meta } = {}) {
    const r = await api(path, { method, body });
    if (retryable(r.status)) {
        enqueue({ path, method, body, label, dedupe, kind, meta });
        return { ...r, ok: true, queued: true };
    }
    return r;
}

let flushing = false;
export async function flushOutbox() {
    if (flushing || !navigator.onLine || readOutbox().length === 0) return;
    flushing = true;
    window.dispatchEvent(new CustomEvent('prdgm:outbox', { detail: { type: 'syncing', count: readOutbox().length } }));
    try {
        for (let list = readOutbox(); list.length; list = readOutbox()) {
            const entry = list[0];
            const r = await api(entry.path, { method: entry.method, body: entry.body });
            if (retryable(r.status)) break; // still down: try again later
            writeOutbox(readOutbox().filter((e) => e.id !== entry.id));
            window.dispatchEvent(new CustomEvent('prdgm:outbox', { detail: { type: r.ok ? 'sent' : 'failed', entry, data: r.data, status: r.status } }));
        }
    } finally {
        flushing = false;
        window.dispatchEvent(new CustomEvent('prdgm:outbox', { detail: { type: 'changed', count: readOutbox().length } }));
    }
}
