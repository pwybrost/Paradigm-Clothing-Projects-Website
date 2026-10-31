// Archive page (index.html). Guests can browse; login is only needed for checkout, wishlist and reviews.
import {
    api, getCurrentUser, logout, placeOrder, quoteCart, getWishlist, addToWishlist, removeFromWishlist,
} from './auth.js';
import {
    mountUserMenu, mountLoginButton, loadCart, saveCart, cartKey, toast, playSound as uiSound, escapeHtml, peso,
    renderFooter, getStoreSettings,
} from './ui.js';

// ---------- Settings you may want to edit ----------
// Size guide shown in the product popup (inches). Adjust to your actual blanks.
const SIZE_GUIDE = [
    { size: 'XS', chest: 19, length: 26 },
    { size: 'S', chest: 20, length: 27 },
    { size: 'M', chest: 21, length: 28 },
    { size: 'L', chest: 22, length: 29 },
    { size: 'XL', chest: 23, length: 30 },
    { size: 'XXL', chest: 24, length: 31 },
    { size: 'XXXL', chest: 25, length: 32 },
];
const NEW_DAYS = 21;          // "New" badge for items added in the last 21 days
const LOW_STOCK = 3;          // "Only N left" at or below this
const RECENT_KEY = 'paradigm_recent';
const CODE_KEY = 'paradigm_code';
const PLACEHOLDER_CARD = 'https://placehold.co/400?text=Paradigm';
const PLACEHOLDER_DETAIL = 'https://placehold.co/800?text=Paradigm';

const $ = (id) => document.getElementById(id);
const playSound = (type) => uiSound(type ?? 'click');
const DAY = 24 * 60 * 60 * 1000;

// ---------- Session ----------
const user = await getCurrentUser();
const isAdmin = user?.role === 'admin';
if (user) {
    $('dispUser').textContent = user.username;
    $('dispEmail').textContent = user.email;
    mountUserMenu(user, { current: 'archive' });
} else {
    $('dispUser').textContent = 'GUEST';
    $('dispEmail').textContent = 'Log in to check out, save a wishlist and track your orders.';
    $('logoutBtn').hidden = true;
    $('loginBtn').hidden = false;
    $('loginBtn').href = 'Login.html?next=index.html';
    mountLoginButton('index.html');
}

let allProducts = [];
let cart = [];
let wishlistIds = new Set();
let settings = null;
let category = 'all';
let sortMode = 'featured';
let lastQuote = null;
let adminApi = null;

// ---------- Helpers ----------
const now = () => Date.now();
const isReleased = (p) => !p.releaseAt || new Date(p.releaseAt).getTime() <= now();
const isNew = (p) => now() - new Date(p.createdAt).getTime() < NEW_DAYS * DAY;
const stockOf = (p, color = null) => p.variants.filter((v) => color === null || v.color === color).reduce((s, v) => s + v.stock, 0);
const colorsOf = (p) => [...new Set(p.variants.map((v) => v.color))];
const findVariant = (p, color, size) => p.variants.find((v) => v.color === color && v.size === size);

function fmtCountdown(ms) {
    if (ms <= 0) return 'LIVE';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const hms = [Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
    return d > 0 ? `${d}D ${hms}` : hms;
}

function badgesFor(p) {
    const b = [];
    const stock = stockOf(p);
    if (isAdmin && p.isActive === false) b.push(['hidden', 'Hidden']);
    if (!isReleased(p)) b.push(['new', 'Upcoming Drop']);
    else if (isNew(p)) b.push(['new', 'New']);
    if (p.compareAtPrice) b.push(['sale', 'Sale']);
    if (p.bestSeller) b.push(['best', 'Best Seller']);
    if (p.isLimited) b.push(['limited', 'Limited']);
    if (stock === 0) b.push(p.allowPreorder ? ['pre', 'Pre-Order'] : ['out', 'Sold Out']);
    else if (stock <= LOW_STOCK) b.push(['low', `Only ${stock} Left`]);
    return b.map(([cls, label]) => `<span class="badge badge-${cls}">${label}</span>`).join('');
}

const priceHtml = (p) => `₱${p.price.toLocaleString()}${p.compareAtPrice ? `<span class="was-price">₱${p.compareAtPrice.toLocaleString()}</span>` : ''}`;
const starText = (r) => '★'.repeat(Math.round(r)) + '☆'.repeat(5 - Math.round(r));

// ---------- Loading ----------
function preloadImages(products) {
    return Promise.all(products.map((p) => new Promise((resolve) => {
        const img = new Image();
        img.onload = resolve;
        img.onerror = resolve;
        img.src = p.image || PLACEHOLDER_CARD;
    })));
}

async function fetchProducts() {
    const res = await fetch('/api/products', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Product API responded with ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Product API returned an unexpected payload');
    return data;
}

async function loadWishlistIds() {
    if (!user) return;
    const { ok, data } = await getWishlist();
    if (ok) wishlistIds = new Set(data.items.map((i) => i.id));
}

async function init() {
    let loadError = null;
    try {
        [allProducts, , settings] = await Promise.all([fetchProducts(), loadWishlistIds(), getStoreSettings()]);
        await preloadImages(allProducts);
    } catch (e) {
        console.error('Failed to load the archive from the API.', e);
        loadError = e;
        allProducts = [];
    }

    renderFooter($('siteFooter'), settings);
    renderAnnouncement();

    if (loadError) {
        $('product-list').innerHTML = '<div class="no-matches">--- [ ARCHIVE OFFLINE · RETRY LATER ] ---</div>';
    } else {
        // Owner console: only downloaded for admin accounts. The server checks the role on every admin request.
        if (isAdmin) {
            const admin = await import('./admin.js');
            adminApi = await admin.mount({
                getProducts: () => allProducts,
                setProducts: (list) => { allProducts = list; renderCategoryChips(); applyFilters(); },
                rerender: () => applyFilters(),
            });
        }
        renderCategoryChips();
        applyFilters();
        restoreCart();
        renderRecent();
    }

    const loader = $('loaderScreen');
    loader?.classList.add('fade-out');
    $('product-list')?.classList.add('grid-enter');
    if (loader) setTimeout(() => { loader.style.display = 'none'; }, 800);

    if (!loadError) {
        const params = new URLSearchParams(location.search);
        const itemId = Number(params.get('item'));
        if (itemId && allProducts.some((p) => p.id === itemId)) openProduct(itemId, { sound: false });
        // Orders.html "View Cart" / Login redirect land here with #cart.
        if (location.hash === '#cart') {
            openCheckout();
            history.replaceState(null, '', location.pathname + location.search);
        }
    }
}

// ---------- Announcement ----------
function renderAnnouncement() {
    const text = settings?.announcement;
    if (!text) return;
    $('announceText').textContent = text;
    if (settings.announcementUntil && new Date(settings.announcementUntil).getTime() > now()) {
        $('announceTimer').dataset.countdown = settings.announcementUntil;
    }
    $('announceBar').hidden = false;
}

// ---------- Categories, sort, filters ----------
function renderCategoryChips() {
    const cats = [...new Set(allProducts.map((p) => p.category).filter(Boolean))].sort();
    if (category !== 'all' && !cats.includes(category)) category = 'all';
    $('categoryChips').innerHTML = ['all', ...cats].map((c) =>
        `<button class="chip${c === category ? ' active' : ''}" data-cat="${escapeHtml(c)}">${c === 'all' ? 'All' : escapeHtml(c)}</button>`).join('');
}
$('categoryChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cat]');
    if (!chip) return;
    playSound();
    category = chip.dataset.cat;
    renderCategoryChips();
    applyFilters();
});
$('sortSelect').addEventListener('change', (e) => { playSound(); sortMode = e.target.value; applyFilters(); });

const SORTS = {
    featured: () => 0,
    newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    'price-asc': (a, b) => a.price - b.price,
    'price-desc': (a, b) => b.price - a.price,
    best: (a, b) => b.popularity - a.popularity,
    rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.reviewCount - a.reviewCount,
};

window.applyFilters = () => {
    const query = $('archiveSearch').value.toLowerCase().trim();
    const minStr = $('minPrice').value;
    const maxStr = $('maxPrice').value;
    let min = minStr === '' ? 0 : Math.abs(parseFloat(minStr));
    let max = maxStr === '' ? Infinity : Math.abs(parseFloat(maxStr));
    if (min > max && max !== Infinity) [min, max] = [max, min];

    const filtered = allProducts.filter((p) => {
        const matchesSearch = p.title.toLowerCase().includes(query) || p.desc.toLowerCase().includes(query)
            || (p.category || '').toLowerCase().includes(query);
        const matchesPrice = p.price >= min && p.price <= max;
        const matchesCat = category === 'all' || p.category === category;
        return matchesSearch && matchesPrice && matchesCat;
    });
    // Stable sort keeps the owner's "featured" order for ties.
    renderGrid(filtered.map((p, i) => [p, i]).sort((a, b) => SORTS[sortMode](a[0], b[0]) || a[1] - b[1]).map(([p]) => p));
};
$('archiveSearch').addEventListener('input', applyFilters);

// ---------- Grid ----------
function cardButton(p) {
    if (!isReleased(p)) return '<button class="btn" disabled>Locked</button>';
    if (stockOf(p) === 0 && !p.allowPreorder) return `<button class="btn" onclick="event.stopPropagation(); openProduct(${p.id})">Sold Out · Notify Me</button>`;
    return `<button class="btn" onclick="event.stopPropagation(); quickAdd(${p.id})">Add to Cart</button>`;
}

function renderGrid(productsToDisplay) {
    const container = $('product-list');
    if (productsToDisplay.length === 0 && !isAdmin) {
        container.innerHTML = '<div class="no-matches">--- [ NO MATCHING DATA FOUND ] ---</div>';
        return;
    }
    const addCard = isAdmin
        ? '<div class="product-card admin-add-card" onclick="adminCreate()"><span>＋</span><span>Register New Item</span></div>'
        : '';

    container.innerHTML = addCard + productsToDisplay.map((p) => {
        const soldOut = stockOf(p) === 0 && !p.allowPreorder;
        return `
        <div class="product-card${soldOut ? ' is-sold-out' : ''}" onclick="openProduct(${p.id})">
            ${isAdmin ? `<button class="admin-edit-btn" title="Edit item" onclick="event.stopPropagation(); adminEdit(${p.id})">✎ EDIT</button>` : ''}
            ${adminApi?.cardExtras?.(p) ?? ''}
            <button class="wish-btn${wishlistIds.has(p.id) ? ' is-active' : ''}" data-wish="${p.id}" title="Wishlist" onclick="event.stopPropagation(); toggleWishlist(${p.id})">${wishlistIds.has(p.id) ? '♥' : '♡'}</button>
            <img src="${escapeHtml(p.image || PLACEHOLDER_CARD)}" alt="${escapeHtml(p.title)}" loading="lazy" onerror="this.onerror=null; this.src='${PLACEHOLDER_CARD}'">
            ${!isReleased(p) ? `<div class="drop-veil">Drops In<b data-countdown="${escapeHtml(p.releaseAt)}"></b></div>` : ''}
            <div class="badge-stack">${badgesFor(p)}</div>
            <h4>${escapeHtml(p.title)}</h4>
            <p class="price">${priceHtml(p)}${p.reviewCount ? `<span class="card-rating">★${p.rating}</span>` : ''}</p>
            ${cardButton(p)}
        </div>`;
    }).join('');
    tickCountdowns();
}

// Card "Add to Cart": adds directly when there's only one option, otherwise opens the popup to pick a size.
window.quickAdd = (id) => {
    const p = allProducts.find((x) => x.id === id);
    if (!p) return;
    const options = p.variants.filter((v) => v.stock > 0 || p.allowPreorder);
    if (options.length === 1) {
        addVariantToCart(p, options[0].color, options[0].size);
        return;
    }
    openProduct(id);
    toast('Select a size');
};

// ---------- Countdowns (drops + announcement) ----------
let releasedSinceRender = false;
function tickCountdowns() {
    document.querySelectorAll('[data-countdown]').forEach((el) => {
        const ms = new Date(el.dataset.countdown).getTime() - now();
        el.textContent = fmtCountdown(ms);
        if (ms <= 0 && el.closest('.product-card')) releasedSinceRender = true;
    });
    if (releasedSinceRender) {
        releasedSinceRender = false;
        applyFilters();
        if (modalProduct) renderProductModal();
    }
}
setInterval(tickCountdowns, 1000);

// ---------- Wishlist ----------
function paintWishlist(id) {
    const on = wishlistIds.has(id);
    document.querySelectorAll(`[data-wish="${id}"]`).forEach((b) => { b.classList.toggle('is-active', on); b.textContent = on ? '♥' : '♡'; });
    document.querySelectorAll(`[data-wish-modal="${id}"]`).forEach((b) => { b.textContent = on ? '♥ In Wishlist' : '♡ Wishlist'; });
}
const goLogin = (message) => {
    toast(message);
    setTimeout(() => { window.location.href = `Login.html?next=${encodeURIComponent(`index.html${location.search}`)}`; }, 1200);
};
window.toggleWishlist = async (id) => {
    playSound();
    if (!user) return goLogin('Log in to save items');
    const adding = !wishlistIds.has(id);
    adding ? wishlistIds.add(id) : wishlistIds.delete(id);
    paintWishlist(id);
    const { ok } = adding ? await addToWishlist(id) : await removeFromWishlist(id);
    if (!ok) {
        adding ? wishlistIds.delete(id) : wishlistIds.add(id);
        paintWishlist(id);
        toast('Wishlist sync failed. Retry.', 'error');
        return;
    }
    toast(adding ? 'Saved to wishlist' : 'Removed from wishlist');
};

// ---------- Recently viewed ----------
function rememberViewed(id) {
    let ids = [];
    try { ids = JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { /* ignore */ }
    ids = [id, ...ids.filter((x) => x !== id)].slice(0, 12);
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids));
}
const miniCard = (p) => `
    <div class="mini-card" onclick="openProduct(${p.id})">
        <img src="${escapeHtml(p.image || PLACEHOLDER_CARD)}" alt="" loading="lazy">
        <span>${escapeHtml(p.title)}</span><b>₱${p.price.toLocaleString()}</b>
    </div>`;
function renderRecent() {
    let ids = [];
    try { ids = JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { /* ignore */ }
    const items = ids.map((id) => allProducts.find((p) => p.id === id)).filter(Boolean).slice(0, 10);
    $('recentStrip').hidden = items.length === 0;
    $('recentRow').innerHTML = items.map(miniCard).join('');
}

// ---------- Product popup ----------
let modalProduct = null;
let selColor = '';
let selSize = '';
let selImage = '';

window.openProduct = (id, { sound = true } = {}) => {
    const p = allProducts.find((x) => x.id === id);
    if (!p) return;
    if (sound) playSound();
    modalProduct = p;
    const colors = colorsOf(p);
    selColor = colors.find((c) => stockOf(p, c) > 0) ?? colors[0] ?? '';
    const sizes = p.variants.filter((v) => v.color === selColor);
    selSize = sizes.length === 1 ? sizes[0].size : '';
    selImage = p.image || PLACEHOLDER_DETAIL;
    renderProductModal();
    $('productModal').classList.add('active');
    $('productModal').scrollTop = 0;
    rememberViewed(id);
    renderRecent();
    const params = new URLSearchParams(location.search);
    params.set('item', id);
    history.replaceState(null, '', `${location.pathname}?${params}`);
    loadReviews(p.id);
};

function stockNote(p) {
    if (!isReleased(p)) return ['', `Drops ${new Date(p.releaseAt).toLocaleString()}`];
    if (!selSize) return ['', 'Select a size'];
    const v = findVariant(p, selColor, selSize);
    if (!v) return ['is-out', 'Unavailable'];
    if (v.stock === 0) return p.allowPreorder ? ['is-pre', 'Pre-order · ships when restocked'] : ['is-out', 'Sold out in this size'];
    if (v.stock <= LOW_STOCK) return ['is-low', `Only ${v.stock} left in ${selSize}`];
    return ['', `In stock · ${selSize}`];
}

function renderProductModal() {
    const p = modalProduct;
    if (!p) return;
    const colors = colorsOf(p);
    const sizes = p.variants.filter((v) => v.color === selColor);
    const v = selSize ? findVariant(p, selColor, selSize) : null;
    const canAdd = isReleased(p) && (!v || v.stock > 0 || p.allowPreorder);
    const showNotify = isReleased(p) && v && v.stock === 0 && !p.allowPreorder;
    const [noteCls, noteText] = stockNote(p);
    const images = [p.image, ...(p.gallery ?? [])].filter(Boolean);
    const related = allProducts
        .filter((x) => x.id !== p.id && isReleased(x))
        .sort((a, b) => (b.category === p.category) - (a.category === p.category) || b.popularity - a.popularity)
        .slice(0, 4);
    const addLabel = !isReleased(p) ? `Drops In <span data-countdown="${escapeHtml(p.releaseAt)}"></span>`
        : v && v.stock === 0 && p.allowPreorder ? 'Confirm Pre-Order' : 'Confirm Add to Cart';

    $('productDetailContent').innerHTML = `
        <div class="product-detail-flex">
            <div class="img-col">
                <div class="img-zoom-container" onmousemove="zoomImage(event, this)" onmouseleave="resetZoom(this)">
                    <img id="detailImg" src="${escapeHtml(selImage)}" alt="${escapeHtml(p.title)}" onerror="this.onerror=null; this.src='${PLACEHOLDER_DETAIL}'">
                </div>
                ${images.length > 1 ? `<div class="gallery-thumbs">${images.map((src) => `<img src="${escapeHtml(src)}" class="${src === selImage ? 'active' : ''}" data-thumb="${escapeHtml(src)}" alt="">`).join('')}</div>` : ''}
            </div>
            <div class="detail-info">
                <div>
                    <div class="detail-meta">${escapeHtml(p.category || 'Archive')} · Item #${p.id}</div>
                    <h2 class="text-[24px] tracking-[4px] uppercase mb-[15px]">${escapeHtml(p.title)}</h2>
                    ${p.reviewCount ? `<div class="detail-rating" data-jump="reviews">${starText(p.rating)} ${p.rating} · ${p.reviewCount} review(s)</div>` : ''}
                    <p class="text-[12px] text-[#aaa] leading-[1.8] tracking-[1px]">${escapeHtml(p.desc)}</p>
                    ${colors.length > 1 || colors[0] ? `
                        <div class="opt-label"><span>Colour · ${escapeHtml(selColor || 'Default')}</span></div>
                        <div class="chip-row">${colors.map((c) => `<button class="chip${c === selColor ? ' active' : ''}" data-color="${escapeHtml(c)}">${escapeHtml(c || 'Default')}</button>`).join('')}</div>` : ''}
                    <div class="opt-label"><span>Size${selSize ? ` · ${selSize}` : ''}</span><button data-guide>Size Guide</button></div>
                    <div class="chip-row">${sizes.map((s) => `<button class="chip${s.size === selSize ? ' active' : ''}" data-size="${s.size}" ${s.stock === 0 && !p.allowPreorder ? 'title="Sold out"' : ''}>${s.size}${s.stock === 0 ? (p.allowPreorder ? ' ·PRE' : ' ✕') : ''}</button>`).join('')}</div>
                    <div class="stock-note ${noteCls}">${escapeHtml(noteText)}</div>
                </div>
                <div>
                    <p class="text-[20px] text-accent font-mono mb-5">${priceHtml(p)}</p>
                    <div class="detail-actions">
                        ${showNotify
                            ? '<button class="btn btn-blue" data-notify>Notify Me When Restocked</button>'
                            : `<button class="btn btn-blue" data-add ${canAdd ? '' : 'disabled'}>${addLabel}</button>`}
                        <div class="row">
                            <button class="btn" data-wish-modal="${p.id}" onclick="toggleWishlist(${p.id})">${wishlistIds.has(p.id) ? '♥ In Wishlist' : '♡ Wishlist'}</button>
                            <button class="btn" data-share>⇪ Share</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <div class="section-label" id="reviewsAnchor">Reviews</div>
        <div id="reviewsBox"><div class="guide-note">Loading reviews...</div></div>
        ${related.length ? `<div class="section-label">You Might Also Like</div><div class="related-row">${related.map(miniCard).join('')}</div>` : ''}`;
    tickCountdowns();
    if (reviewsCache?.productId === p.id) renderReviews();
}

$('productDetailContent').addEventListener('click', async (e) => {
    const p = modalProduct;
    if (!p) return;
    const t = e.target;
    if (t.closest('[data-thumb]')) {
        playSound();
        selImage = t.closest('[data-thumb]').dataset.thumb;
        $('detailImg').src = selImage;
        document.querySelectorAll('.gallery-thumbs img').forEach((img) => img.classList.toggle('active', img.dataset.thumb === selImage));
    } else if (t.closest('[data-color]')) {
        playSound();
        selColor = t.closest('[data-color]').dataset.color;
        if (!findVariant(p, selColor, selSize)) selSize = '';
        renderProductModal();
    } else if (t.closest('[data-size]')) {
        playSound();
        selSize = t.closest('[data-size]').dataset.size;
        renderProductModal();
    } else if (t.closest('[data-guide]')) {
        openSizeGuide();
    } else if (t.closest('[data-add]')) {
        if (!selSize) { playSound('error'); toast('Select a size first', 'error'); return; }
        addVariantToCart(p, selColor, selSize);
    } else if (t.closest('[data-notify]')) {
        playSound();
        if (!user) return goLogin('Log in to get restock alerts');
        const { ok, data } = await api(`/api/products/${p.id}/notify`, { method: 'POST', body: { size: selSize, color: selColor } });
        if (ok) toast(data.alreadyRequested ? 'Already on the restock list' : `We'll let you know when ${selSize} is back`);
        else { playSound('error'); toast('Request failed. Retry.', 'error'); }
    } else if (t.closest('[data-share]')) {
        playSound();
        const url = `${location.origin}${location.pathname}?item=${p.id}`;
        try {
            if (navigator.share) await navigator.share({ title: `${p.title} | Paradigm`, url });
            else { await navigator.clipboard.writeText(url); toast('Link copied'); }
        } catch { /* share cancelled */ }
    } else if (t.closest('[data-jump]')) {
        $('reviewsAnchor').scrollIntoView({ behavior: 'smooth' });
    }
});

// Clearing ?item= when the popup closes keeps shared links clean.
window.closeModal = (id) => {
    $(id).classList.remove('active');
    if (id === 'productModal') {
        modalProduct = null;
        const params = new URLSearchParams(location.search);
        params.delete('item');
        history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
    }
};

// ---------- Magnifying glass (unchanged) ----------
window.zoomImage = (e, container) => {
    const img = container.querySelector('img');
    const rect = container.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    img.style.transformOrigin = `${x}% ${y}%`;
    img.style.transform = 'scale(2.5)';
};
window.resetZoom = (container) => {
    const img = container.querySelector('img');
    img.style.transform = 'scale(1)';
    img.style.transformOrigin = 'center center';
};

// ---------- Size guide ----------
function openSizeGuide() {
    playSound();
    const sizes = modalProduct ? new Set(modalProduct.variants.map((v) => v.size)) : null;
    const rows = SIZE_GUIDE.filter((r) => !sizes || sizes.has(r.size));
    $('sizeGuideBody').innerHTML = `
        <table class="guide-table">
            <thead><tr><th>Size</th><th>Chest (in)</th><th>Length (in)</th><th>Chest (cm)</th><th>Length (cm)</th></tr></thead>
            <tbody>${rows.map((r) => `<tr><td>${r.size}</td><td>${r.chest}</td><td>${r.length}</td><td>${Math.round(r.chest * 2.54)}</td><td>${Math.round(r.length * 2.54)}</td></tr>`).join('')}</tbody>
        </table>
        <p class="guide-note">Measured flat, armpit to armpit (chest) and shoulder to hem (length). Between sizes? Size up for an oversized fit.${user?.sizePreference ? ` Your saved size: <span class="text-accent">${escapeHtml(user.sizePreference)}</span>.` : ''}</p>`;
    $('sizeGuideModal').classList.add('active');
}

// ---------- Reviews ----------
let reviewsCache = null;
let draftRating = 0;

async function loadReviews(productId) {
    const { ok, data } = await api(`/api/products/${productId}/reviews`);
    if (modalProduct?.id !== productId) return;
    reviewsCache = ok ? { productId, ...data } : { productId, reviews: [], canReview: false, signedIn: Boolean(user), failed: true };
    const mine = reviewsCache.reviews.find((r) => r.mine);
    draftRating = mine?.rating ?? 0;
    renderReviews();
}

function renderReviews() {
    const box = $('reviewsBox');
    if (!box || !reviewsCache) return;
    const { reviews, canReview, signedIn, failed } = reviewsCache;
    const mine = reviews.find((r) => r.mine);
    const avg = reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0;
    const list = reviews.length
        ? `<div class="detail-rating">${starText(avg)} ${avg.toFixed(1)} · ${reviews.length} verified review(s)</div>${reviews.map((r) => `
            <div class="review">
                <div class="review-head">
                    <span class="review-stars">${starText(r.rating)}</span>
                    <span class="review-who">${escapeHtml(r.name)}<span class="verified">✓ Verified Buyer</span> · ${new Date(r.createdAt).toLocaleDateString()}${r.edited ? ' · edited' : ''}
                        ${isAdmin && !r.mine ? ` <button class="link-btn" data-mod-review="${escapeHtml(r.id)}">Remove</button>` : ''}</span>
                </div>
                ${r.body ? `<div class="review-body">${escapeHtml(r.body)}</div>` : ''}
            </div>`).join('')}`
        : `<div class="guide-note">${failed ? 'Reviews unavailable right now.' : 'No reviews yet.'}</div>`;

    let form = '';
    if (canReview) {
        form = `
            <div class="review-form">
                <div class="opt-label"><span>${mine ? 'Edit your review' : 'Write a review'}</span>${mine ? '<button data-review-delete>Delete</button>' : ''}</div>
                <div class="star-input">${[1, 2, 3, 4, 5].map((n) => `<button data-star="${n}" class="${n <= draftRating ? 'on' : ''}" aria-label="${n} star">★</button>`).join('')}</div>
                <textarea class="search-input" id="reviewBody" maxlength="1000" placeholder="How's the fit, print and fabric?">${escapeHtml(mine?.body ?? '')}</textarea>
                <button class="btn btn-blue" data-review-submit>${mine ? 'Update Review' : 'Post Review'}</button>
            </div>`;
    } else {
        form = `<p class="guide-note mt-2.5">${signedIn ? 'Only customers who bought this item can review it.' : 'Log in and purchase this item to leave a review.'}</p>`;
    }
    box.innerHTML = list + form;
}

$('productDetailContent').addEventListener('click', async (e) => {
    const p = modalProduct;
    if (!p) return;
    const star = e.target.closest('[data-star]');
    if (star) {
        playSound();
        draftRating = Number(star.dataset.star);
        document.querySelectorAll('[data-star]').forEach((b) => b.classList.toggle('on', Number(b.dataset.star) <= draftRating));
        return;
    }
    if (e.target.closest('[data-review-submit]')) {
        if (!draftRating) { playSound('error'); toast('Pick a star rating', 'error'); return; }
        const body = $('reviewBody').value;
        const { ok, data } = await api(`/api/products/${p.id}/reviews`, { method: 'PUT', body: { rating: draftRating, body } });
        if (ok) { playSound('success'); toast('Review posted'); loadReviews(p.id); }
        else { playSound('error'); toast(data.error === 'purchase_required' ? 'Only buyers can review' : 'Could not post review', 'error'); }
        return;
    }
    if (e.target.closest('[data-review-delete]')) {
        playSound();
        const { ok } = await api(`/api/products/${p.id}/reviews`, { method: 'DELETE' });
        if (ok) { draftRating = 0; toast('Review deleted'); loadReviews(p.id); }
        return;
    }
    const mod = e.target.closest('[data-mod-review]');
    if (mod && isAdmin) {
        playSound();
        const { ok } = await api(`/api/admin/reviews/${mod.dataset.modReview}`, { method: 'DELETE' });
        if (ok) { toast('Review removed'); loadReviews(p.id); }
        else { playSound('error'); toast('Remove failed', 'error'); }
    }
});

// ---------- Cart ----------
function maxQty(item) {
    const p = allProducts.find((x) => x.id === item.id);
    const v = p && findVariant(p, item.color, item.size);
    if (!p || !v) return 99;
    return p.allowPreorder ? 99 : Math.max(1, Math.min(99, v.stock));
}

function addVariantToCart(p, color, size) {
    const v = findVariant(p, color, size);
    if (!v || !isReleased(p) || (v.stock === 0 && !p.allowPreorder)) { playSound('error'); toast('Not available', 'error'); return; }
    const key = cartKey({ id: p.id, color, size });
    const item = cart.find((i) => cartKey(i) === key);
    const limit = p.allowPreorder ? 99 : v.stock;
    if (item) {
        if (item.quantity >= limit) { playSound('error'); toast(`Only ${limit} available in ${size}`, 'error'); return; }
        item.quantity++;
    } else {
        cart.push({ id: p.id, name: p.title, price: p.price, color, size, quantity: 1 });
    }
    playSound();
    toast(`${p.title} · ${size}${color ? ` · ${color}` : ''} added`);
    updateCartUI();
}

// Restore the saved cart, dropping removed items and refreshing names/prices from the API.
function restoreCart() {
    cart = loadCart().flatMap((i) => {
        const p = allProducts.find((x) => x.id === i.id);
        return p && findVariant(p, i.color, i.size)
            ? [{ id: p.id, name: p.title, price: p.price, color: i.color, size: i.size, quantity: Math.min(99, i.quantity) }]
            : [];
    });
    const code = sessionStorage.getItem(CODE_KEY);
    if (code) $('discountInput').value = code;
    updateCartUI();
}

function changeQty(item, delta) {
    if (!item) return;
    playSound();
    const next = item.quantity + delta;
    if (next < 1) cart = cart.filter((i) => i !== item);
    else if (next > maxQty(item)) { toast(`Only ${maxQty(item)} available`, 'error'); return; }
    else item.quantity = next;
    updateCartUI();
}
$('cart-items-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-idx]');
    if (!btn) return;
    const item = cart[Number(btn.dataset.idx)];
    if (!item) return;
    if (btn.hasAttribute('data-remove')) {
        playSound();
        cart = cart.filter((i) => i !== item);
        updateCartUI();
    } else {
        changeQty(item, Number(btn.dataset.delta));
    }
});

let quoteTimer;
function updateCartUI() {
    saveCart(cart);
    const count = cart.reduce((sum, i) => sum + i.quantity, 0);
    $('checkoutTrigger').textContent = `Execute Order (${count})`;
    renderCartList();
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(refreshQuote, 250);
}

function renderCartList() {
    const problems = new Map((lastQuote?.problems ?? []).map((pr) => [cartKey(pr), pr]));
    const preorders = new Set((lastQuote?.lines ?? []).filter((l) => l.isPreorder).map((l) => cartKey({ id: l.productId, color: l.color, size: l.size })));
    $('cart-items-list').innerHTML = cart.map((i, idx) => {
        const key = cartKey(i);
        const pr = problems.get(key);
        const warn = pr ? ({ out_of_stock: `Only ${pr.available} left · reduce quantity`, unavailable: 'No longer available · remove', not_released: 'Not released yet' }[pr.problem]) : '';
        return `
        <div class="checkout-item">
            <span class="flex-1">${escapeHtml(i.name)}
                <span class="cart-meta">SIZE ${escapeHtml(i.size)}${i.color ? ` · ${escapeHtml(i.color)}` : ''} · ₱${i.price.toLocaleString()} EA</span>
                ${warn ? `<span class="cart-meta is-warn">${warn}</span>` : preorders.has(key) ? '<span class="cart-meta is-pre">Pre-order · ships when restocked</span>' : ''}
            </span>
            <div class="flex items-center gap-2 mx-[15px]">
                <button class="qty-btn" data-idx="${idx}" data-delta="-1">-</button>
                <span>${i.quantity}</span>
                <button class="qty-btn" data-idx="${idx}" data-delta="1">+</button>
            </div>
            <span class="text-accent w-20 text-right">₱${(i.price * i.quantity).toLocaleString()}</span>
            <button class="remove-btn" data-idx="${idx}" data-remove>X</button>
        </div>`;
    }).join('') || '<p class="text-center text-[#444] p-5">CART EMPTY</p>';
}

const CODE_ERRORS = {
    invalid_code: 'Code not recognised',
    code_expired: 'Code has expired',
    code_used_up: 'Code has reached its limit',
    code_minimum_not_met: 'Minimum spend not met',
};

async function refreshQuote() {
    const items = cart.map((i) => ({ id: i.id, size: i.size, color: i.color, quantity: i.quantity }));
    const code = $('discountInput').value.trim();
    if (items.length === 0) {
        lastQuote = null;
        paintTotals({ subtotal: 0, bundleDiscount: 0, discount: 0, shippingFee: 0, total: 0, freeShippingRemaining: 0, problems: [] });
        return;
    }
    const { ok, data } = await quoteCart(items, code);
    if (!ok) {
        // Offline estimate so the cart still shows something sensible.
        const subtotal = cart.reduce((s, i) => s + i.price * i.quantity, 0);
        paintTotals({
            subtotal, bundleDiscount: 0, discount: 0, shippingFee: settings?.shippingFee ?? 0,
            total: subtotal + (settings?.shippingFee ?? 0), problems: [],
            freeShippingRemaining: Math.max(0, (settings?.freeShippingMin ?? 0) - subtotal),
        });
        $('codeNote').textContent = code ? 'Code will be checked at checkout' : '';
        return;
    }
    lastQuote = data.quote;
    renderCartList();
    paintTotals(lastQuote);
    const note = $('codeNote');
    note.className = 'checkout-note';
    if (!code) note.textContent = '';
    else if (lastQuote.discountCode) { note.textContent = `✓ ${lastQuote.discountCode} applied`; note.classList.add('is-ok'); }
    else if (lastQuote.codeError) {
        const ce = lastQuote.codeError;
        note.textContent = ce.error === 'code_minimum_not_met' ? `Minimum spend ${peso(ce.minSubtotal)}` : (CODE_ERRORS[ce.error] || 'Invalid code');
        note.classList.add('is-error');
    }
}

function paintTotals(q) {
    $('sumSubtotal').textContent = peso(q.subtotal);
    $('sumBundleRow').hidden = !q.bundleDiscount;
    $('sumBundle').textContent = `−${peso(q.bundleDiscount)}`;
    $('sumBundleLabel').textContent = settings?.bundleMinQty ? `BUNDLE DEAL (${settings.bundleMinQty}+ ITEMS, ${settings.bundlePercent}% OFF)` : 'BUNDLE DEAL';
    $('sumDiscountRow').hidden = !q.discount;
    $('sumDiscount').textContent = `−${peso(q.discount)}`;
    $('sumDiscountLabel').textContent = q.discountCode ? `CODE ${q.discountCode}` : 'DISCOUNT';
    $('sumShipping').textContent = q.shippingFee ? peso(q.shippingFee) : (cart.length ? 'FREE' : peso(0));
    $('total-price').textContent = q.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    $('dueTotal').textContent = peso(q.total);

    const min = settings?.freeShippingMin ?? 0;
    const prog = $('shipProgress');
    const bundleHint = settings?.bundleMinQty > 0 && settings.bundlePercent > 0 && !q.bundleDiscount && cart.length
        ? `<br>Add ${Math.max(0, settings.bundleMinQty - cart.reduce((s, i) => s + i.quantity, 0))} more item(s) for ${settings.bundlePercent}% off` : '';
    if (!cart.length || min <= 0) { prog.innerHTML = bundleHint.replace('<br>', ''); return; }
    const remaining = q.freeShippingRemaining ?? 0;
    const pct = Math.max(0, Math.min(100, ((min - remaining) / min) * 100));
    prog.innerHTML = `${remaining > 0 ? `${peso(remaining)} away from free shipping` : '✓ Free shipping unlocked'}${bundleHint}<div class="ship-bar"><i style="width:${pct}%"></i></div>`;
}

$('applyCodeBtn').addEventListener('click', () => {
    playSound();
    const code = $('discountInput').value.trim().toUpperCase();
    $('discountInput').value = code;
    code ? sessionStorage.setItem(CODE_KEY, code) : sessionStorage.removeItem(CODE_KEY);
    refreshQuote();
});
$('discountInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('applyCodeBtn').click(); });

// ---------- Checkout ----------
// ---------- Payment options ----------
const METHOD_LABELS = { gcash: 'GCash', paymaya: 'Maya', card: 'Card', grab_pay: 'GrabPay', qrph: 'QR Ph', dob: 'Online Banking', billease: 'BillEase' };
let payMethod = 'cod';
function renderPayOptions() {
    const online = Boolean(settings?.onlinePayments);
    if (!online) payMethod = 'cod';
    const methods = (settings?.paymentMethods ?? []).map((m) => METHOD_LABELS[m] || m).join(' · ');
    const option = (value, title, note) => `
        <label class="pay-box pay-option${payMethod === value ? ' active' : ''}" data-pay="${value}">
            <input type="radio" name="payMethod" value="${value}" ${payMethod === value ? 'checked' : ''}> ◆ ${title}<small>${note}</small>
        </label>`;
    $('payOptions').innerHTML = (online ? option('online', `Pay Online${methods ? ` · ${methods}` : ''}`, 'Secure payment page by PayMongo. Your order is confirmed instantly.') : '')
        + option('cod', 'Cash on Delivery', 'Pay the courier when your order arrives.');
    $('confirmCheckoutBtn').textContent = payMethod === 'online' ? 'Proceed to Payment ►' : 'Finalize Transmission';
}
$('payOptions').addEventListener('click', (e) => {
    const opt = e.target.closest('[data-pay]');
    if (!opt || opt.dataset.pay === payMethod) return;
    playSound();
    payMethod = opt.dataset.pay;
    renderPayOptions();
});

function showStep(step) {
    $('stepCart').hidden = step !== 'cart';
    $('stepShip').hidden = step !== 'ship';
    $('checkoutTitle').textContent = step === 'cart' ? 'MANIFEST' : 'SHIPPING MANIFEST';
}

function openCheckout() {
    showStep('cart');
    $('status-msg').innerHTML = '';
    $('toShippingBtn').textContent = user ? 'Proceed to Shipping ►' : 'Log In to Check Out ►';
    $('checkoutModal').classList.add('active');
    refreshQuote();
}
$('checkoutTrigger').addEventListener('click', () => { playSound(); openCheckout(); });

$('toShippingBtn').addEventListener('click', async () => {
    playSound();
    if (cart.length === 0) { $('status-msg').innerHTML = "<span class='text-danger'>CART EMPTY.</span>"; return; }
    if (!user) { window.location.href = `Login.html?next=${encodeURIComponent('index.html#cart')}`; return; }
    await refreshQuote();
    if (lastQuote?.problems?.length) {
        playSound('error');
        $('status-msg').innerHTML = "<span class='text-danger'>FIX THE HIGHLIGHTED ITEMS FIRST.</span>";
        return;
    }
    // Prefill from the profile.
    const a = user.shippingAddress || {};
    const fill = (id, value) => { if (!$(id).value) $(id).value = value || ''; };
    fill('shipName', [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username);
    fill('shipPhone', user.phone);
    fill('shipLine1', a.line1); fill('shipLine2', a.line2); fill('shipCity', a.city);
    fill('shipProvince', a.province); fill('shipPostal', a.postalCode);
    if (a.country) $('shipCountry').value = a.country;
    $('status-msg').innerHTML = '';
    if (settings?.onlinePayments && payMethod === 'cod' && !$('payOptions').innerHTML) payMethod = 'online';
    renderPayOptions();
    showStep('ship');
});
$('backToCartBtn').addEventListener('click', () => { playSound(); showStep('cart'); $('status-msg').innerHTML = ''; });

const CHECKOUT_ERRORS = {
    shipping_incomplete: 'ERROR: COMPLETE NAME, ADDRESS, CITY, PROVINCE AND POSTAL CODE.',
    invalid_phone: 'ERROR: ENTER A VALID CONTACT NUMBER.',
    cart_problem: 'ERROR: SOME ITEMS CHANGED. REVIEW YOUR CART.',
    discount_invalid: 'ERROR: DISCOUNT CODE NO LONGER VALID.',
    not_authenticated: 'ERROR: SESSION EXPIRED. PLEASE LOG IN AGAIN.',
    size_required: 'ERROR: EVERY ITEM NEEDS A SIZE.',
    email_unverified: "ERROR: VERIFY YOUR EMAIL FIRST. <a class='underline' href='Profile.html'>OPEN PROFILE</a>",
    payments_unavailable: 'ERROR: ONLINE PAYMENT IS OFFLINE. CHOOSE CASH ON DELIVERY.',
    payment_unavailable: 'ERROR: PAYMENT PAGE UNAVAILABLE. ORDER RELEASED · RETRY OR USE CASH ON DELIVERY.',
};

window.processCheckout = async () => {
    const btn = $('confirmCheckoutBtn');
    if (cart.length === 0 || !user || btn.disabled) return;
    const status = $('status-msg');
    const shipping = {
        name: $('shipName').value, phone: $('shipPhone').value, line1: $('shipLine1').value, line2: $('shipLine2').value,
        city: $('shipCity').value, province: $('shipProvince').value, postalCode: $('shipPostal').value, country: $('shipCountry').value,
    };
    if (!shipping.name.trim() || !shipping.line1.trim() || !shipping.city.trim() || !shipping.province.trim() || !shipping.postalCode.trim()) {
        playSound('error');
        status.innerHTML = `<span class='text-danger'>${CHECKOUT_ERRORS.shipping_incomplete}</span>`;
        return;
    }
    btn.disabled = true;
    status.innerHTML = 'COMMENCING ENCRYPTED UPLOAD...';

    // Keep the original upload animation timing (at least 2s).
    const [result] = await Promise.all([
        placeOrder({
            items: cart.map((i) => ({ id: i.id, size: i.size, color: i.color, quantity: i.quantity })),
            shipping,
            notes: $('shipNotes').value,
            discountCode: $('discountInput').value.trim(),
            saveAddress: $('saveAddress').checked,
            paymentMethod: payMethod,
        }),
        new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    btn.disabled = false;

    if (result.success && result.data?.checkoutUrl) {
        // Online payment: cart is cleared now; the order is held for 2 hours while the customer pays.
        playSound('success');
        status.innerHTML = `<span class='text-accent'>ORDER #${escapeHtml(result.order.id)} RESERVED. ROUTING TO SECURE PAYMENT...</span>`;
        cart = [];
        sessionStorage.removeItem(CODE_KEY);
        updateCartUI();
        setTimeout(() => { window.location.href = result.data.checkoutUrl; }, 1200);
        return;
    }
    if (result.success) {
        playSound('success');
        const id = escapeHtml(result.order.id);
        status.innerHTML = `<span class='text-accent'>ORDER #${id} DEPLOYED SUCCESSFULLY. PAYLOAD SAVED.</span><br><a class="text-accent underline" href="Orders.html">VIEW MY ORDERS</a> · <a class="text-accent underline" href="Receipt.html?order=${id}" target="_blank">RECEIPT</a>`;
        cart = [];
        sessionStorage.removeItem(CODE_KEY);
        $('discountInput').value = '';
        $('shipNotes').value = '';
        updateCartUI();
        // Refresh stock so badges and size buttons are current.
        fetchProducts().then((list) => { if (!isAdmin) { allProducts = list; applyFilters(); } }).catch(() => {});
        setTimeout(() => { closeModal('checkoutModal'); showStep('cart'); }, 4000);
        return;
    }
    playSound('error');
    status.innerHTML = `<span class='text-danger'>${CHECKOUT_ERRORS[result.error] || 'ERROR: TRANSMISSION FAILED. PLEASE RETRY.'}</span>`;
    if (result.error === 'cart_problem' || result.error === 'discount_invalid') {
        try { allProducts = isAdmin ? allProducts : await fetchProducts(); applyFilters(); } catch { /* keep current */ }
        showStep('cart');
        refreshQuote();
    }
    if (result.error === 'not_authenticated') setTimeout(() => { window.location.href = 'Login.html?next=index.html%23cart'; }, 2000);
};
$('confirmCheckoutBtn').addEventListener('click', () => processCheckout());

// ---------- Misc ----------
$('themeToggleBtn').addEventListener('click', () => {
    playSound();
    document.documentElement.classList.toggle('light-mode');
    localStorage.setItem('paradigm_theme', document.documentElement.classList.contains('light-mode') ? 'light' : 'dark');
});
$('logoutBtn').addEventListener('click', () => logout());
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const id of ['sizeGuideModal', 'productModal', 'checkoutModal']) {
        if ($(id).classList.contains('active')) { closeModal(id); break; }
    }
});

init();
