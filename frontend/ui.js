// Shared UI helpers for the archive, profile and orders pages.
import { logout, flushOutbox, readOutbox, sendOrQueue } from './auth.js';

// ---------- Sounds (same Web Audio tones as Login/Signup) ----------
let audioCtx;
let lastPlayed = 0;

// Runs fn right after the next frame is painted, so work like audio setup never delays a click's visual response.
export const afterPaint = (fn) => requestAnimationFrame(() => setTimeout(fn, 0));

export function playSound(type = 'click') {
    const now = Date.now();
    if (type === 'click' && now - lastPlayed < 100) return;
    lastPlayed = now;
    afterPaint(() => playTone(type));
}

function playTone(type) {
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

// Theme switch: transitions are paused for one frame so hundreds of elements don't animate their colours at once.
export function toggleTheme() {
    const h = document.documentElement;
    h.classList.add('theme-switching');
    const light = h.classList.toggle('light-mode');
    requestAnimationFrame(() => requestAnimationFrame(() => h.classList.remove('theme-switching')));
    afterPaint(() => { try { localStorage.setItem('paradigm_theme', light ? 'light' : 'dark'); } catch { /* private mode */ } });
}

export function initThemeToggle(button) {
    button?.addEventListener('click', () => { toggleTheme(); playSound('click'); });
}

// ---------- Cart (kept in localStorage so it survives page changes; prices and stock are re-checked by the server) ----------
const CART_KEY = 'paradigm_cart';
export const cartKey = (i) => `${i.id}|${i.color || ''}|${i.size}`;
export function loadCart() {
    try {
        const raw = JSON.parse(localStorage.getItem(CART_KEY));
        return Array.isArray(raw)
            ? raw.filter((i) => Number.isInteger(i?.id) && Number.isInteger(i?.quantity) && i.quantity > 0 && typeof i.size === 'string' && i.size)
                .map((i) => ({ ...i, color: typeof i.color === 'string' ? i.color : '' }))
            : [];
    } catch {
        return [];
    }
}
export function saveCart(cart, { touch = true } = {}) {
    if (touch) localStorage.setItem('paradigm_cart_ts', String(Date.now()));
    localStorage.setItem(CART_KEY, JSON.stringify(cart.map(({ id, name, price, size, color, quantity }) => ({ id, name, price, size, color, quantity }))));
}
// item: { id, name, price, size, color, quantity }
export function addToStoredCart(item) {
    const cart = loadCart();
    const existing = cart.find((i) => cartKey(i) === cartKey(item));
    if (existing) existing.quantity = Math.min(99, existing.quantity + (item.quantity || 1));
    else cart.push({ id: item.id, name: item.name, price: item.price, size: item.size, color: item.color || '', quantity: Math.min(99, item.quantity || 1) });
    saveCart(cart);
    return cart.reduce((sum, i) => sum + i.quantity, 0);
}

// ---------- Store settings (shipping, announcement, social links) ----------
let settingsPromise;
export function getStoreSettings() {
    settingsPromise ??= fetch('/api/store/settings', { headers: { Accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    return settingsPromise;
}

// ---------- Guest "Login" button (sits where the profile button goes) ----------
export function mountLoginButton(next = 'index.html') {
    const host = document.getElementById('headerActions');
    if (!host) return;
    const a = document.createElement('a');
    a.className = 'header-btn btn-login';
    a.href = `Login.html?next=${encodeURIComponent(next)}`;
    a.textContent = '◉ Login';
    a.addEventListener('click', () => playSound('click'));
    host.prepend(a);
}

// ---------- Footer ----------
export function renderFooter(el, settings) {
    if (!el) return;
    const social = settings?.social ?? {};
    const socialLinks = [['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['facebook', 'Facebook']]
        .filter(([k]) => social[k])
        .map(([k, label]) => `<a href="${escapeHtml(social[k])}" target="_blank" rel="noopener noreferrer">${label}</a>`)
        .join('');
    el.innerHTML = `
        <div class="footer-inner">
            <div>
                <div class="footer-title">Paradigm Clothing Projects</div>
                <p class="footer-about">Graphic tees, collabs and limited drops. Designed in the Philippines. Cash on delivery nationwide.</p>
                ${socialLinks ? `<div class="footer-social">${socialLinks}</div>` : ''}
            </div>
            <div class="footer-links">
                <div class="footer-title">Information</div>
                <a href="Info.html#about">About</a>
                <a href="Info.html#faq">FAQ</a>
                <a href="Info.html#shipping">Shipping &amp; Returns</a>
                <a href="Info.html#contact">Contact</a>
                <a href="Info.html#terms">Terms</a>
                <a href="Info.html#privacy">Privacy Policy</a>
            </div>
            <div>
                <div class="footer-title">Join the Transmission</div>
                <p class="footer-about mb-2.5">Drop alerts and restocks, straight to your inbox.</p>
                <form class="newsletter" id="newsletterForm">
                    <input class="search-input" type="email" id="newsletterEmail" placeholder="EMAIL ADDRESS" required maxlength="254" />
                    <button class="btn btn-blue" type="submit">Subscribe</button>
                </form>
            </div>
        </div>
        <div class="footer-bottom">Paradigm Clothing Projects · All Rights Reserved</div>`;
    el.querySelector('#newsletterForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button');
        if (btn.disabled) return;
        btn.disabled = true;
        const email = el.querySelector('#newsletterEmail').value.trim();
        const res = await sendOrQueue('/api/store/newsletter', { method: 'POST', body: { email }, label: 'Newsletter signup' });
        btn.disabled = false;
        if (res.queued) { toast('Offline · you will be subscribed when the connection returns'); e.target.reset(); }
        else if (res.ok) { playSound('success'); toast('Subscribed. Welcome to the transmission'); e.target.reset(); }
        else { playSound('error'); toast(res.status === 429 ? 'Too many attempts. Try later' : 'Enter a valid email', 'error'); }
    });
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
            ${item('Info.html#contact', 'Help &amp; Contact', 'info')}
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

// ---------- Connectivity + offline sync ----------
// Shows a small bar when offline or when saved actions are waiting, and sends them when back online.
let netBar;
function paintNetBar(syncing = false) {
    netBar ??= Object.assign(document.createElement('div'), { className: 'net-bar', role: 'status' });
    if (!netBar.isConnected) document.body.appendChild(netBar);
    const queued = readOutbox().length;
    const offline = !navigator.onLine;
    netBar.classList.toggle('is-syncing', !offline && (syncing || queued > 0));
    netBar.textContent = offline
        ? `◆ Offline · showing saved data${queued ? ` · ${queued} action(s) will sync when you're back` : ''}`
        : queued ? `◆ Syncing ${queued} saved action(s)...` : '';
    netBar.classList.toggle('show', offline || queued > 0);
}

function onOutboxEvent(e) {
    const { type, entry, data } = e.detail;
    if (type === 'syncing') return paintNetBar(true);
    if (type === 'changed') return paintNetBar();
    if (entry?.kind === 'order') {
        if (type === 'sent') {
            playSound('success');
            toast(data?.checkoutUrl ? `Order #${data.order?.id} placed · complete payment in My Orders` : `Saved order #${data?.order?.id} placed`);
        } else {
            // Order couldn't go through (e.g. an item sold out meanwhile): put the items back in the cart.
            for (const item of entry.meta?.cart ?? []) addToStoredCart(item);
            playSound('error');
            toast('A saved order could not be placed · items are back in your cart', 'error');
        }
        window.dispatchEvent(new CustomEvent('prdgm:cart-restored'));
    } else if (type === 'sent' && entry?.label) {
        toast(`${entry.label} synced`);
    } else if (type === 'failed' && entry?.label && entry.kind !== 'cart') {
        toast(`${entry.label} could not be synced`, 'error');
    }
}

let connectivityStarted = false;
export function initConnectivity() {
    if (connectivityStarted) return;
    connectivityStarted = true;
    window.addEventListener('prdgm:outbox', onOutboxEvent);
    window.addEventListener('online', () => { paintNetBar(); flushOutbox(); });
    window.addEventListener('offline', () => paintNetBar());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) flushOutbox(); });
    setInterval(() => { if (!document.hidden) flushOutbox(); }, 30_000);
    const start = () => { paintNetBar(); flushOutbox(); };
    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start) : start();
}
initConnectivity();
