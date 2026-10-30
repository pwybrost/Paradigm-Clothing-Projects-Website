// Shared UI helpers for the archive, profile and orders pages.
import { logout } from './auth.js';

// ---------- Sounds (same Web Audio tones as Login/Signup) ----------
let audioCtx;
let lastPlayed = 0;
export function playSound(type = 'click') {
    const now = Date.now();
    if (type === 'click' && now - lastPlayed < 100) return;
    lastPlayed = now;
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain); gain.connect(audioCtx.destination);
        const t = audioCtx.currentTime;
        if (type === 'success') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(400, t);
            osc.frequency.setValueAtTime(800, t + 0.1);
            osc.frequency.setValueAtTime(1200, t + 0.2);
            gain.gain.setValueAtTime(0.1, t);
            gain.gain.linearRampToValueAtTime(0, t + 0.5);
            osc.start(); osc.stop(t + 0.5);
        } else if (type === 'error') {
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(150, t);
            osc.frequency.setValueAtTime(100, t + 0.1);
            gain.gain.setValueAtTime(0.1, t);
            gain.gain.linearRampToValueAtTime(0, t + 0.3);
            osc.start(); osc.stop(t + 0.3);
        } else if (type === 'purge') {
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(200, t);
            osc.frequency.exponentialRampToValueAtTime(50, t + 0.8);
            gain.gain.setValueAtTime(0.2, t);
            gain.gain.linearRampToValueAtTime(0, t + 0.8);
            osc.start(); osc.stop(t + 0.8);
        } else {
            osc.type = 'square';
            osc.frequency.setValueAtTime(150, t);
            gain.gain.setValueAtTime(0.02, t);
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
            osc.start(); osc.stop(t + 0.1);
        }
    } catch { /* audio not available */ }
}

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export const peso = (n) => `₱${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function initThemeToggle(button) {
    button?.addEventListener('click', () => {
        playSound('click');
        document.documentElement.classList.toggle('light-mode');
        localStorage.setItem('paradigm_theme', document.documentElement.classList.contains('light-mode') ? 'light' : 'dark');
    });
}

// ---------- Cart (kept in localStorage so it survives page changes; prices are re-checked by the server) ----------
const CART_KEY = 'paradigm_cart';
export function loadCart() {
    try {
        const raw = JSON.parse(localStorage.getItem(CART_KEY));
        return Array.isArray(raw) ? raw.filter((i) => Number.isInteger(i?.id) && Number.isInteger(i?.quantity) && i.quantity > 0) : [];
    } catch {
        return [];
    }
}
export function saveCart(cart) {
    localStorage.setItem(CART_KEY, JSON.stringify(cart.map(({ id, name, price, quantity }) => ({ id, name, price, quantity }))));
}
export function addToStoredCart(product) {
    const cart = loadCart();
    const item = cart.find((i) => i.id === product.id);
    if (item) item.quantity = Math.min(99, item.quantity + 1);
    else cart.push({ id: product.id, name: product.title, price: product.price, quantity: 1 });
    saveCart(cart);
    return cart.reduce((sum, i) => sum + i.quantity, 0);
}

// ---------- Toast ----------
let toastTimer;
export function toast(message, tone = 'ok') {
    let el = document.getElementById('prdgmToast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'prdgmToast';
        el.className = 'prdgm-toast';
        document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.toggle('is-error', tone === 'error');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- Profile button + dropdown (sits next to the Theme button) ----------
export function mountUserMenu(user, { current } = {}) {
    const host = document.getElementById('headerActions');
    if (!host || !user) return;

    const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username;
    const avatar = user.avatar
        ? `<img class="menu-avatar" src="${escapeHtml(user.avatar)}" alt="">`
        : '<span class="menu-avatar menu-avatar-empty">◉</span>';
    const item = (href, label, key) =>
        `<a class="user-menu-item${current === key ? ' is-current' : ''}" href="${href}">${label}</a>`;

    const wrap = document.createElement('div');
    wrap.className = 'user-menu-wrap';
    wrap.innerHTML = `
        <button class="header-btn btn-profile" id="profileMenuBtn" aria-haspopup="true" aria-expanded="false">${avatar}<span>Profile</span></button>
        <div class="user-menu" id="userMenu" role="menu">
            <div class="user-menu-head">
                <div class="user-menu-name">${escapeHtml(displayName)}</div>
                <div class="user-menu-mail">${escapeHtml(user.email)}</div>
                <span class="role-badge${user.role === 'admin' ? ' is-admin' : ''}">${user.role === 'admin' ? 'OWNER // ADMIN' : 'MEMBER'}</span>
            </div>
            ${item('Profile.html', 'Personal Profile', 'profile')}
            ${item('Profile.html#history', 'History &amp; Transactions', 'history')}
            ${item('Orders.html', 'My Orders', 'orders')}
            ${item('Orders.html#wishlist', 'Wishlist', 'wishlist')}
            ${item('index.html', 'Archive', 'archive')}
            <button class="user-menu-item is-danger" id="menuLogoutBtn">Disconnect</button>
        </div>`;
    host.prepend(wrap);

    const btn = wrap.querySelector('#profileMenuBtn');
    const menu = wrap.querySelector('#userMenu');
    const setOpen = (open) => {
        menu.classList.toggle('open', open);
        btn.setAttribute('aria-expanded', String(open));
    };
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        playSound('click');
        setOpen(!menu.classList.contains('open'));
    });
    menu.addEventListener('click', (e) => {
        if (e.target.closest('.user-menu-item')) playSound('click');
    });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
    wrap.querySelector('#menuLogoutBtn').addEventListener('click', () => logout());
}
