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
    return ok ? { success: true } : { success: false, error: data.error };
}

// Returns { success: true, user } or { success: false, error: 'invalid_credentials' | 'network_error' | ... }
export async function login(email, password) {
    const { ok, data } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
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
    window.location.href = 'Login.html';
}

// items: [{ id, quantity }]. Prices are calculated by the server.
export async function placeOrder(items) {
    const { ok, data } = await api('/api/orders', { method: 'POST', body: { items } });
    return ok ? { success: true, order: data.order } : { success: false, error: data.error };
}

// ---------- Profile ----------
export const getProfile = () => api('/api/profile');
export const updateProfile = (fields) => api('/api/profile', { method: 'PATCH', body: fields });
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
export const addToWishlist = (productId) => api(`/api/wishlist/${productId}`, { method: 'PUT' });
export const removeFromWishlist = (productId) => api(`/api/wishlist/${productId}`, { method: 'DELETE' });
