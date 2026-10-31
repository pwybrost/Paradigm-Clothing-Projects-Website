// Owner console for the archive page. shop.js only imports this for role === 'admin',
// and every request it makes is checked again by the server (/api/admin requires the admin role).
import { api } from './auth.js';
import { escapeHtml, peso, playSound as uiSound, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const playSound = (t) => uiSound(t ?? 'click');
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString() : '—');
const errText = (data) => String(data?.error || 'error').replace(/_/g, ' ');
const STATUSES = ['pending', 'paid', 'shipped', 'completed', 'cancelled'];
const RETURN_STATUSES = ['requested', 'approved', 'rejected', 'completed'];
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
const EXPENSE_CATEGORIES = ['production', 'shipping', 'packaging', 'marketing', 'platform', 'other'];
const toLocalInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

let ctx;
let editing = null;
let pendingImage = null;
let pnlRange = '30d';
let lastPnl = null;
let adminOrders = [];
let orderFilter = 'all';
let arrangeMode = false;
let reorderTimer;
let storeSettings = null;

// ---------- Setup ----------
export async function mount(context) {
    ctx = context;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'styles/admin.css';
    document.head.appendChild(link);

    injectConsole();
    injectModals();
    window.adminEdit = (id) => openEditor(id);
    window.adminCreate = () => openEditor(null);
    window.adminMove = (id, dir) => moveProduct(id, dir);

    await refreshProducts();
    loadSettings();
    return { cardExtras };
}

async function refreshProducts() {
    const { ok, data } = await api('/api/admin/products');
    if (ok) ctx.setProducts(data.products);
    paintLowStockBadge();
}

async function loadSettings() {
    const { ok, data } = await api('/api/admin/settings');
    if (ok) { storeSettings = data.settings; paintLowStockBadge(); }
}

function lowStockList() {
    const threshold = storeSettings?.lowStockThreshold ?? 3;
    return ctx.getProducts().flatMap((p) => p.variants
        .filter((v) => v.stock <= threshold)
        .map((v) => ({ product: p, ...v })));
}
function paintLowStockBadge() {
    const n = lowStockList().length;
    const btn = $('admStockBtn');
    if (btn) btn.textContent = n ? `Stock ⚠ ${n}` : 'Stock';
}

function cardExtras(p) {
    if (!arrangeMode) return '';
    return `<div class="admin-move" onclick="event.stopPropagation()">
        <button title="Move earlier" onclick="adminMove(${p.id}, -1)">◄</button>
        <button title="Move later" onclick="adminMove(${p.id}, 1)">►</button>
    </div>`;
}

function injectConsole() {
    const bar = document.createElement('div');
    bar.className = 'admin-console';
    bar.innerHTML = `
        <div class="admin-console-inner">
            <span class="admin-console-label">◆ Owner Console</span>
            <button class="btn" id="admNewBtn">＋ New Item</button>
            <button class="btn" id="admArrangeBtn">⇄ Arrange</button>
            <button class="btn btn-blue" id="admPnlBtn">P&amp;L Tracker</button>
            <button class="btn btn-blue" id="admOrdersBtn">Orders Menu</button>
            <button class="btn" id="admReturnsBtn">Returns</button>
            <button class="btn" id="admCustomersBtn">Customers</button>
            <button class="btn" id="admStockBtn">Stock</button>
            <button class="btn" id="admDiscountsBtn">Discounts</button>
            <button class="btn" id="admInboxBtn">Inbox</button>
            <button class="btn" id="admSettingsBtn">Store Settings</button>
            <button class="btn" id="admDeletedBtn">Deleted Records</button>
        </div>`;
    document.querySelector('.filter-wrapper').after(bar);
    $('admNewBtn').addEventListener('click', () => openEditor(null));
    $('admArrangeBtn').addEventListener('click', toggleArrange);
    $('admPnlBtn').addEventListener('click', openPnl);
    $('admOrdersBtn').addEventListener('click', openOrders);
    $('admReturnsBtn').addEventListener('click', openReturns);
    $('admCustomersBtn').addEventListener('click', openCustomers);
    $('admStockBtn').addEventListener('click', openStock);
    $('admDiscountsBtn').addEventListener('click', openDiscounts);
    $('admInboxBtn').addEventListener('click', openInbox);
    $('admSettingsBtn').addEventListener('click', openSettings);
    $('admDeletedBtn').addEventListener('click', openDeleted);
}

function modal(id, inner, size = 'admin-mid') {
    return `<div class="modal-overlay" id="${id}"><div class="modal-content ${size}"><span class="modal-close" data-adm-close="${id}">[ CLOSE ]</span>${inner}</div></div>`;
}

function injectModals() {
    const wrap = document.createElement('div');
    wrap.innerHTML = [
        modal('admEditModal', `
            <h2 class="admin-h2" id="admEditTitle">Edit Artifact</h2>
            <div class="admin-form">
                <div class="admin-photo-col">
                    <div class="admin-photo" id="admPhoto"><img id="admPhotoImg" alt=""><div class="admin-photo-hint">Click to replace main image</div></div>
                    <input type="file" id="admPhotoInput" accept="image/png,image/jpeg,image/webp" hidden>
                    <div class="admin-field mt-3.5"><label>Extra Photos (max 8)</label>
                        <div class="admin-gallery" id="admGallery"></div>
                        <input type="file" id="admGalleryInput" accept="image/png,image/jpeg,image/webp" hidden>
                    </div>
                </div>
                <div class="admin-fields">
                    <div class="admin-field"><label for="admTitle">Name</label><input class="search-input" id="admTitle" maxlength="80"></div>
                    <div class="admin-field"><label for="admDesc">Description</label><textarea class="search-input" id="admDesc" maxlength="2000"></textarea></div>
                    <div class="admin-row">
                        <div class="admin-field"><label for="admCategory">Category</label><input class="search-input" id="admCategory" list="admCategoryList" maxlength="40"><datalist id="admCategoryList"></datalist></div>
                        <div class="admin-field"><label for="admRelease">Drop Date (optional)</label><input class="search-input" id="admRelease" type="datetime-local"></div>
                    </div>
                    <div class="admin-row">
                        <div class="admin-field"><label for="admPrice">Price (₱)</label><input class="search-input" id="admPrice" type="number" min="0" step="0.01"></div>
                        <div class="admin-field"><label for="admCompare">Was Price (₱) · sale</label><input class="search-input" id="admCompare" type="number" min="0" step="0.01" placeholder="blank = no sale"></div>
                        <div class="admin-field"><label for="admCost">Unit Cost (₱)</label><input class="search-input" id="admCost" type="number" min="0" step="0.01"></div>
                    </div>
                    <div class="admin-margin" id="admMargin"></div>
                    <div class="admin-field"><label for="admColors">Colours (comma separated, blank = one colour)</label><input class="search-input" id="admColors" maxlength="200" placeholder="e.g. Black, White"></div>
                    <div class="admin-field"><label>Sizes</label><div class="chip-row" id="admSizes"></div></div>
                    <div class="admin-field"><label>Stock per size</label><div id="admStockGrid"></div></div>
                    <div class="chip-row">
                        <label class="admin-check"><input type="checkbox" id="admVisible"> Visible in shop</label>
                        <label class="admin-check"><input type="checkbox" id="admPreorder"> Allow pre-orders when sold out</label>
                        <label class="admin-check"><input type="checkbox" id="admLimited"> Limited badge</label>
                    </div>
                    <div class="admin-row mt-auto">
                        <button class="btn btn-danger" id="admDeleteBtn">Delete Item</button>
                        <button class="btn btn-blue" id="admSaveBtn">Save Changes</button>
                    </div>
                    <p class="admin-note" id="admEditStatus"></p>
                </div>
            </div>`, 'admin-wide'),
        modal('admDeleteModal', `
            <h2 class="admin-h2 is-danger">Delete <span id="admDeleteName"></span>?</h2>
            <p class="admin-text">The item will be removed from the shop, wishlists and reviews.<br>A full copy (photos and sizes included) is kept in the backend deleted records.</p>
            <div class="admin-field mb-[15px]"><label for="admDeleteReason">Reason (optional)</label><input class="search-input" id="admDeleteReason" maxlength="300"></div>
            <div class="admin-field mb-5"><label for="admDeleteConfirm">Type DELETE to confirm</label><input class="search-input" id="admDeleteConfirm" autocomplete="off"></div>
            <div class="admin-row">
                <button class="btn" data-adm-close="admDeleteModal">Cancel</button>
                <button class="btn btn-danger" id="admDeleteConfirmBtn" disabled>Delete Permanently</button>
            </div>`, ''),
        modal('admConfirmModal', `
            <h2 class="admin-h2" id="admConfirmTitle">Confirm</h2>
            <p class="admin-text" id="admConfirmText"></p>
            <div class="admin-row">
                <button class="btn" id="admConfirmNo">Cancel</button>
                <button class="btn btn-danger" id="admConfirmYes">Confirm</button>
            </div>`, ''),
        modal('admPnlModal', `
            <h2 class="admin-h2">Profit &amp; Loss Tracker</h2>
            <div class="chip-row justify-center" id="admPnlRanges">
                ${['7d', '30d', '90d', '12m', 'all'].map((r) => `<button class="chip${r === pnlRange ? ' active' : ''}" data-range="${r}">${r === 'all' ? 'All Time' : r.toUpperCase()}</button>`).join('')}
                <button class="chip" id="admPnlCsv">⇩ CSV</button>
            </div>
            <div id="admPnlBody"><div class="admin-empty">Computing ledger...</div></div>`, 'admin-wide'),
        modal('admOrdersModal', `
            <h2 class="admin-h2">Orders Menu</h2>
            <div class="admin-toolbar">
                <input class="search-input" id="admOrderSearch" placeholder="Search customer, email, order #, item or tracking...">
                <a class="btn btn-auto" href="/api/admin/orders/export.csv" download>⇩ Export CSV</a>
            </div>
            <div class="chip-row mb-5" id="admOrderFilters">
                ${['all', ...STATUSES].map((s) => `<button class="chip${s === 'all' ? ' active' : ''}" data-status="${s}">${s}</button>`).join('')}
            </div>
            <div class="admin-note mb-2.5" id="admOrderSummary"></div>
            <div id="admOrderList"><div class="admin-empty">Retrieving manifests...</div></div>`, 'admin-wide'),
        modal('admReturnsModal', `
            <h2 class="admin-h2">Returns &amp; Exchanges</h2>
            <div id="admReturnsList"><div class="admin-empty">Loading...</div></div>`, 'admin-wide'),
        modal('admCustomersModal', `
            <h2 class="admin-h2">Customers</h2>
            <div class="admin-toolbar"><input class="search-input" id="admCustomerSearch" placeholder="Search name or email..."></div>
            <div class="admin-note mb-2.5" id="admCustomerSummary"></div>
            <div id="admCustomerList"><div class="admin-empty">Loading...</div></div>`, 'admin-wide'),
        modal('admStockModal', `
            <h2 class="admin-h2">Stock &amp; Restock Requests</h2>
            <div id="admStockBody"><div class="admin-empty">Loading...</div></div>`, 'admin-wide'),
        modal('admDiscountsModal', `
            <h2 class="admin-h2">Discount Codes</h2>
            <form class="admin-inline-form" id="admDiscountForm">
                <input class="search-input" name="code" placeholder="CODE (e.g. PRDGM10)" maxlength="30" required>
                <select class="search-input" name="kind"><option value="percent">% OFF</option><option value="fixed">₱ OFF</option></select>
                <input class="search-input" name="value" type="number" min="0.01" step="0.01" placeholder="Value" required>
                <input class="search-input" name="minSubtotal" type="number" min="0" step="0.01" placeholder="Min ₱ (opt)">
                <input class="search-input" name="maxUses" type="number" min="1" step="1" placeholder="Max uses (opt)">
                <input class="search-input" name="expiresAt" type="datetime-local" title="Expiry (optional)">
                <button class="btn btn-blue" type="submit">Create</button>
            </form>
            <div id="admDiscountList"><div class="admin-empty">Loading...</div></div>`, 'admin-wide'),
        modal('admInboxModal', `
            <h2 class="admin-h2">Inbox</h2>
            <div class="chip-row justify-center mb-5" id="admInboxTabs">
                <button class="chip active" data-inbox="messages">Contact Messages</button>
                <button class="chip" data-inbox="subscribers">Newsletter</button>
            </div>
            <div id="admInboxBody"><div class="admin-empty">Loading...</div></div>`, 'admin-wide'),
        modal('admSettingsModal', `
            <h2 class="admin-h2">Store Settings</h2>
            <div id="admSettingsBody"><div class="admin-empty">Loading...</div></div>`),
        modal('admDeletedModal', `
            <h2 class="admin-h2">Deleted Records</h2>
            <p class="admin-text">Owner-only archive of removed items. Stored in the deleted_products table.</p>
            <div id="admDeletedList"><div class="admin-empty">Loading...</div></div>`),
    ].join('');
    document.body.append(...wrap.children);

    document.addEventListener('click', (e) => {
        const closer = e.target.closest('[data-adm-close]');
        if (closer) { playSound(); closeModal(closer.dataset.admClose); }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const open = [...document.querySelectorAll('.modal-overlay.active')].pop();
        if (open?.id.startsWith('adm')) closeModal(open.id);
    });

    // Editor
    $('admPhoto').addEventListener('click', () => { playSound(); $('admPhotoInput').click(); });
    $('admPhotoInput').addEventListener('change', onPhotoPicked);
    $('admGalleryInput').addEventListener('change', onGalleryPicked);
    $('admGallery').addEventListener('click', onGalleryClick);
    ['admPrice', 'admCost', 'admCompare'].forEach((id) => $(id).addEventListener('input', paintMargin));
    $('admColors').addEventListener('input', () => renderStockGrid(readStockGrid()));
    $('admSizes').addEventListener('click', (e) => {
        const chip = e.target.closest('[data-size]');
        if (!chip) return;
        playSound();
        chip.classList.toggle('active');
        renderStockGrid(readStockGrid());
    });
    $('admSaveBtn').addEventListener('click', saveProduct);
    $('admDeleteBtn').addEventListener('click', () => {
        playSound();
        $('admDeleteName').textContent = editing.title;
        $('admDeleteConfirm').value = '';
        $('admDeleteReason').value = '';
        $('admDeleteConfirmBtn').disabled = true;
        openModal('admDeleteModal');
        setTimeout(() => $('admDeleteConfirm').focus(), 50);
    });
    $('admDeleteConfirm').addEventListener('input', (e) => { $('admDeleteConfirmBtn').disabled = e.target.value.trim() !== 'DELETE'; });
    $('admDeleteConfirmBtn').addEventListener('click', deleteProduct);

    // P&L
    $('admPnlRanges').addEventListener('click', (e) => {
        if (e.target.id === 'admPnlCsv') { playSound(); exportPnlCsv(); return; }
        const chip = e.target.closest('[data-range]');
        if (!chip) return;
        playSound();
        pnlRange = chip.dataset.range;
        document.querySelectorAll('#admPnlRanges [data-range]').forEach((c) => c.classList.toggle('active', c === chip));
        loadPnl();
    });
    $('admPnlBody').addEventListener('click', onPnlClick);
    $('admPnlBody').addEventListener('submit', onExpenseSubmit);

    // Orders
    $('admOrderSearch').addEventListener('input', renderOrders);
    $('admOrderFilters').addEventListener('click', (e) => {
        const chip = e.target.closest('[data-status]');
        if (!chip) return;
        playSound();
        orderFilter = chip.dataset.status;
        document.querySelectorAll('#admOrderFilters .chip').forEach((c) => c.classList.toggle('active', c === chip));
        renderOrders();
    });
    $('admOrderList').addEventListener('click', onOrdersClick);

    $('admReturnsList').addEventListener('click', onReturnsClick);
    $('admCustomerSearch').addEventListener('input', renderCustomers);
    $('admStockBody').addEventListener('click', (e) => {
        const edit = e.target.closest('[data-edit]');
        if (edit) { closeModal('admStockModal'); openEditor(Number(edit.dataset.edit)); }
    });
    $('admDiscountForm').addEventListener('submit', onDiscountCreate);
    $('admDiscountList').addEventListener('click', onDiscountClick);
    $('admInboxTabs').addEventListener('click', (e) => {
        const chip = e.target.closest('[data-inbox]');
        if (!chip) return;
        playSound();
        document.querySelectorAll('#admInboxTabs .chip').forEach((c) => c.classList.toggle('active', c === chip));
        loadInbox(chip.dataset.inbox);
    });
    $('admInboxBody').addEventListener('click', onInboxClick);
    $('admSettingsBody').addEventListener('submit', onSettingsSubmit);
}

const openModal = (id) => $(id).classList.add('active');
const closeModal = (id) => $(id).classList.remove('active');

// Styled replacement for window.confirm().
function confirmDialog(title, text, confirmLabel = 'Confirm', danger = true) {
    return new Promise((resolve) => {
        $('admConfirmTitle').textContent = title;
        $('admConfirmTitle').classList.toggle('is-danger', danger);
        $('admConfirmText').textContent = text;
        $('admConfirmYes').textContent = confirmLabel;
        $('admConfirmYes').className = `btn ${danger ? 'btn-danger' : 'btn-blue'}`;
        const done = (value) => {
            closeModal('admConfirmModal');
            $('admConfirmYes').onclick = null;
            $('admConfirmNo').onclick = null;
            resolve(value);
        };
        $('admConfirmYes').onclick = () => { playSound(danger ? 'purge' : 'click'); done(true); };
        $('admConfirmNo').onclick = () => { playSound(); done(false); };
        openModal('admConfirmModal');
    });
}

// ---------- Arrange mode ----------
function toggleArrange() {
    playSound();
    arrangeMode = !arrangeMode;
    $('admArrangeBtn').classList.toggle('btn-blue', arrangeMode);
    $('admArrangeBtn').textContent = arrangeMode ? '✓ Done Arranging' : '⇄ Arrange';
    if (arrangeMode) {
        // Arranging edits the "Featured" order, so show everything in that order.
        $('sortSelect').value = 'featured';
        $('sortSelect').dispatchEvent(new Event('change'));
        document.querySelector('#categoryChips [data-cat="all"]')?.click();
        toast('Use ◄ ► on each card to set the shop order');
    }
    ctx.rerender();
}

function moveProduct(id, dir) {
    playSound();
    const list = [...ctx.getProducts()];
    const i = list.findIndex((p) => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    ctx.setProducts(list);
    clearTimeout(reorderTimer);
    reorderTimer = setTimeout(async () => {
        const { ok } = await api('/api/admin/products/reorder', { method: 'POST', body: { ids: ctx.getProducts().map((p) => p.id) } });
        ok ? toast('Shop order saved') : toast('Could not save order', 'error');
    }, 700);
}

// ---------- Product editor ----------
function openEditor(id) {
    playSound();
    pendingImage = null;
    $('admPhotoInput').value = '';
    if (id === null) {
        editing = {
            isNew: true, title: '', desc: '', price: '', cost: '', rawCompareAtPrice: null, image: null, category: '',
            releaseAt: null, allowPreorder: false, isLimited: false, isActive: true, gallery: [], galleryIds: [],
            variants: ['S', 'M', 'L', 'XL', 'XXL'].map((size) => ({ color: '', size, stock: 0 })),
        };
    } else {
        const p = ctx.getProducts().find((x) => x.id === id);
        if (!p) return;
        editing = structuredClone(p);
    }
    $('admEditTitle').textContent = editing.isNew ? 'Register New Artifact' : `Edit Artifact #${editing.id}`;
    $('admTitle').value = editing.title;
    $('admDesc').value = editing.desc;
    $('admPrice').value = editing.price;
    $('admCost').value = editing.cost ?? '';
    $('admCompare').value = editing.rawCompareAtPrice ?? '';
    $('admCategory').value = editing.category || '';
    $('admCategoryList').innerHTML = [...new Set(ctx.getProducts().map((p) => p.category).filter(Boolean))]
        .map((c) => `<option value="${escapeHtml(c)}">`).join('');
    $('admRelease').value = toLocalInput(editing.releaseAt);
    $('admVisible').checked = editing.isActive !== false;
    $('admPreorder').checked = Boolean(editing.allowPreorder);
    $('admLimited').checked = Boolean(editing.isLimited);
    const colors = [...new Set(editing.variants.map((v) => v.color))].filter(Boolean);
    $('admColors').value = colors.join(', ');
    const activeSizes = new Set(editing.variants.map((v) => v.size));
    $('admSizes').innerHTML = SIZES.map((s) => `<button class="chip${activeSizes.has(s) ? ' active' : ''}" data-size="${s}">${s}</button>`).join('');
    renderStockGrid(editing.variants);
    $('admDeleteBtn').hidden = Boolean(editing.isNew);
    $('admSaveBtn').textContent = editing.isNew ? 'Publish Item' : 'Save Changes';
    $('admEditStatus').textContent = editing.isNew ? 'A main photo is required for new items.' : '';
    paintPhoto(editing.image);
    renderGallery();
    paintMargin();
    openModal('admEditModal');
}

const currentColors = () => {
    const list = $('admColors').value.split(',').map((c) => c.trim().replace(/\s+/g, ' ')).filter(Boolean);
    return list.length ? [...new Set(list)] : [''];
};
const currentSizes = () => [...document.querySelectorAll('#admSizes .chip.active')].map((c) => c.dataset.size);

function readStockGrid() {
    return [...document.querySelectorAll('#admStockGrid input[data-color]')].map((input) => ({
        color: input.dataset.color, size: input.dataset.size, stock: Number.parseInt(input.value, 10) || 0,
    }));
}

function renderStockGrid(previous) {
    const colors = currentColors();
    const sizes = currentSizes();
    const prev = new Map(previous.map((v) => [`${v.color.toLowerCase()}|${v.size}`, v.stock]));
    // A single unnamed colour keeps the stock entered for the first colour, and vice versa.
    const lookup = (color, size) => prev.get(`${color.toLowerCase()}|${size}`)
        ?? (previous.length && [...new Set(previous.map((v) => v.color))].length === 1 ? prev.get(`${previous[0].color.toLowerCase()}|${size}`) : undefined)
        ?? 0;
    if (!sizes.length) { $('admStockGrid').innerHTML = '<p class="admin-note is-warn">Select at least one size.</p>'; return; }
    $('admStockGrid').innerHTML = `
        <table class="admin-table admin-stock-table">
            <thead><tr><th>Colour</th>${sizes.map((s) => `<th class="num">${s}</th>`).join('')}</tr></thead>
            <tbody>${colors.map((c) => `<tr><td>${escapeHtml(c || 'Default')}</td>${sizes.map((s) => `
                <td class="num"><input class="search-input stock-input" type="number" min="0" step="1" data-color="${escapeHtml(c)}" data-size="${s}" value="${lookup(c, s)}"></td>`).join('')}</tr>`).join('')}
            </tbody>
        </table>`;
}

function paintPhoto(src) {
    $('admPhoto').classList.toggle('is-empty', !src);
    $('admPhotoImg').src = src || 'https://placehold.co/800?text=Upload+Image';
}

function renderGallery() {
    if (editing.isNew) {
        $('admGallery').innerHTML = '<p class="admin-note">Publish the item first, then add extra photos.</p>';
        return;
    }
    const thumbs = editing.gallery.map((src, i) => `
        <div class="admin-thumb"><img src="${escapeHtml(src)}" alt=""><button data-gallery-del="${escapeHtml(editing.galleryIds[i])}" title="Remove">✕</button></div>`).join('');
    $('admGallery').innerHTML = thumbs + (editing.gallery.length < 8 ? '<button class="admin-thumb admin-thumb-add" data-gallery-add>＋</button>' : '');
}

async function onGalleryClick(e) {
    if (e.target.closest('[data-gallery-add]')) { playSound(); $('admGalleryInput').click(); return; }
    const del = e.target.closest('[data-gallery-del]');
    if (!del) return;
    if (!(await confirmDialog('Remove Photo?', 'This extra photo will be deleted.', 'Remove'))) return;
    const { ok, data } = await api(`/api/admin/products/${editing.id}/gallery/${del.dataset.galleryDel}`, { method: 'DELETE' });
    if (!ok) { playSound('error'); toast(`Remove failed: ${errText(data)}`, 'error'); return; }
    applyProductUpdate(data.product);
    toast('Photo removed');
}

async function onGalleryPicked(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
        $('admEditStatus').textContent = 'Uploading photo...';
        const image = await resizeImage(file);
        const { ok, data } = await api(`/api/admin/products/${editing.id}/gallery`, { method: 'POST', body: { image } });
        $('admEditStatus').textContent = '';
        if (!ok) { playSound('error'); toast(`Upload failed: ${errText(data)}`, 'error'); return; }
        applyProductUpdate(data.product);
        playSound('success');
        toast('Photo added');
    } catch {
        $('admEditStatus').textContent = '';
        playSound('error'); toast('Could not process that image', 'error');
    }
}

// Merges a fresh product from the server into the list and the open editor (gallery only, so unsaved edits stay).
function applyProductUpdate(product) {
    const list = ctx.getProducts();
    const old = list.find((p) => p.id === product.id);
    const merged = { ...product, restockRequests: old?.restockRequests ?? 0 };
    ctx.setProducts(list.some((p) => p.id === product.id) ? list.map((p) => (p.id === product.id ? merged : p)) : [merged, ...list]);
    if (editing && editing.id === product.id) {
        editing.gallery = product.gallery;
        editing.galleryIds = product.galleryIds;
        renderGallery();
    }
    paintLowStockBadge();
}

function paintMargin() {
    const price = Number.parseFloat($('admPrice').value) || 0;
    const cost = Number.parseFloat($('admCost').value) || 0;
    const compare = Number.parseFloat($('admCompare').value) || 0;
    const profit = price - cost;
    const el = $('admMargin');
    el.classList.toggle('is-neg', profit < 0);
    const sale = compare > price && price > 0 ? ` · Sale: <b>${Math.round((1 - price / compare) * 100)}% off</b>` : '';
    el.innerHTML = price > 0
        ? `Profit per unit: <b>${peso(profit)}</b> · Margin: <b>${Math.round((profit / price) * 100)}%</b>${sale}`
        : 'Set a price to see margin.';
}

// Resize in the browser to max 1600px WebP (keeps uploads well under the server limit).
async function resizeImage(file, maxSide = 1600) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 25 * 1024 * 1024) throw new Error('bad_file');
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.9, 0.8, 0.7]) {
        let url = canvas.toDataURL('image/webp', quality);
        if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', quality);
        if (url.length * 0.75 < 2.4 * 1024 * 1024) return url;
    }
    throw new Error('too_large');
}

async function onPhotoPicked(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
        $('admEditStatus').textContent = 'Processing image...';
        pendingImage = await resizeImage(file);
        paintPhoto(pendingImage);
        $('admEditStatus').textContent = 'New image ready. Save to apply.';
    } catch {
        playSound('error'); toast('Use a PNG, JPG or WEBP under 25 MB', 'error');
        $('admEditStatus').textContent = '';
    }
}

async function saveProduct() {
    const btn = $('admSaveBtn');
    if (btn.disabled) return;
    const variants = readStockGrid();
    const body = {
        title: $('admTitle').value.trim(),
        desc: $('admDesc').value.trim(),
        price: $('admPrice').value,
        cost: $('admCost').value || 0,
        compareAtPrice: $('admCompare').value || null,
        category: $('admCategory').value.trim(),
        releaseAt: $('admRelease').value ? new Date($('admRelease').value).toISOString() : null,
        allowPreorder: $('admPreorder').checked,
        isLimited: $('admLimited').checked,
        isActive: $('admVisible').checked,
        variants,
    };
    if (!body.title) { playSound('error'); toast('Name is required', 'error'); return; }
    if (!(Number.parseFloat(body.price) >= 0)) { playSound('error'); toast('Enter a valid price', 'error'); return; }
    if (!variants.length) { playSound('error'); toast('Add at least one size', 'error'); return; }
    if (editing.isNew && !pendingImage) { playSound('error'); toast('Upload a main photo first', 'error'); return; }
    if (pendingImage) body.image = pendingImage;

    btn.disabled = true;
    $('admEditStatus').textContent = 'Transmitting...';
    const { ok, data } = editing.isNew
        ? await api('/api/admin/products', { method: 'POST', body })
        : await api(`/api/admin/products/${editing.id}`, { method: 'PATCH', body });
    btn.disabled = false;
    $('admEditStatus').textContent = '';

    if (!ok) { playSound('error'); toast(`Save failed: ${errText(data)}`, 'error'); return; }
    const wasNew = editing.isNew;
    editing = { ...data.product };
    applyProductUpdate(data.product);
    playSound('success');
    toast(wasNew ? 'Item published · add extra photos below' : 'Item updated');
    if (wasNew) openEditor(data.product.id);
    else closeModal('admEditModal');
}

async function deleteProduct() {
    const btn = $('admDeleteConfirmBtn');
    if (btn.disabled || $('admDeleteConfirm').value.trim() !== 'DELETE') return;
    btn.disabled = true;
    const { ok, data } = await api(`/api/admin/products/${editing.id}`, {
        method: 'DELETE',
        body: { confirm: 'DELETE', reason: $('admDeleteReason').value },
    });
    if (!ok) {
        btn.disabled = false;
        playSound('error');
        toast(`Delete failed: ${errText(data)}`, 'error');
        return;
    }
    ctx.setProducts(ctx.getProducts().filter((p) => p.id !== editing.id));
    closeModal('admDeleteModal');
    closeModal('admEditModal');
    playSound('purge');
    toast(`Item deleted · archived as record #${data.archiveId}`);
    paintLowStockBadge();
}

// ---------- Profit & loss ----------
function openPnl() {
    playSound();
    openModal('admPnlModal');
    loadPnl();
}

async function loadPnl() {
    $('admPnlBody').innerHTML = '<div class="admin-empty">Computing ledger...</div>';
    const { ok, data } = await api(`/api/admin/pnl?range=${pnlRange}`);
    if (!ok) { $('admPnlBody').innerHTML = '<div class="admin-empty">--- [ LEDGER OFFLINE ] ---</div>'; return; }
    lastPnl = data;
    renderPnl(data);
}

function bucketLabel(period, bucket) {
    const d = new Date(period);
    if (bucket === 'month') return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderPnl(d) {
    const s = d.summary;
    const sign = (n) => (n < 0 ? 'is-neg' : n > 0 ? 'is-pos' : '');
    const stat = (label, value, cls = '') => `<div class="pnl-stat"><div class="pnl-stat-value ${cls}">${value}</div><div class="pnl-stat-label">${label}</div></div>`;
    const max = Math.max(1, ...d.timeline.map((t) => Math.max(t.revenue, Math.abs(t.profit))));
    const today = new Date().toISOString().slice(0, 10);

    $('admPnlBody').innerHTML = `
        <div class="pnl-stats">
            ${stat('Revenue (realized)', peso(s.revenue))}
            ${stat('Cost of Goods', peso(s.cogs))}
            ${stat('Other Expenses', peso(s.expenses))}
            ${stat('Net Profit / Loss', peso(s.netProfit), sign(s.netProfit))}
            ${stat('Gross Profit', peso(s.grossProfit), sign(s.grossProfit))}
            ${stat('Net Margin', s.margin === null ? '—' : `${(s.margin * 100).toFixed(1)}%`, sign(s.margin ?? 0))}
            ${stat('Discounts Given', peso(s.discounts ?? 0))}
            ${stat('Shipping Collected', peso(s.shippingCollected ?? 0))}
            ${stat('Orders · Units', `${s.orders} · ${s.units}`)}
            ${stat(`Pending (${s.pendingOrders} orders)`, peso(s.pendingRevenue))}
        </div>
        <p class="admin-note">Revenue is what customers paid (after discounts, including shipping fees) on orders marked paid, shipped or completed. Pending orders are shown separately; cancelled orders are excluded. Log courier costs as shipping expenses.</p>

        <div class="pnl-section">Timeline · per ${d.bucket}</div>
        ${d.timeline.length ? `
            <div class="pnl-chart">
                ${d.timeline.map((t) => `
                    <div class="pnl-bar-group" title="${bucketLabel(t.period, d.bucket)} · Revenue ${peso(t.revenue)} · Profit ${peso(t.profit)}">
                        <div class="pnl-bars">
                            <div class="pnl-bar rev" style="height:${(t.revenue / max) * 100}%"></div>
                            <div class="pnl-bar pro${t.profit < 0 ? ' is-neg' : ''}" style="height:${(Math.abs(t.profit) / max) * 100}%"></div>
                        </div>
                        <div class="pnl-bar-label">${bucketLabel(t.period, d.bucket)}</div>
                    </div>`).join('')}
            </div>
            <div class="pnl-legend"><span><i class="bg-accent"></i>Revenue</span><span><i class="bg-[#34d399]"></i>Profit</span><span><i class="bg-danger"></i>Loss</span></div>
        ` : '<div class="admin-empty">--- [ NO SALES IN THIS RANGE ] ---</div>'}

        <div class="pnl-section">Top Items</div>
        ${d.topProducts.length ? `
            <table class="admin-table">
                <thead><tr><th>Item</th><th class="num">Units</th><th class="num">Sales (before discounts)</th><th class="num">Profit</th></tr></thead>
                <tbody>${d.topProducts.map((p) => `<tr><td>${escapeHtml(p.title)}</td><td class="num">${p.units}</td><td class="num accent">${peso(p.revenue)}</td><td class="num">${peso(p.profit)}</td></tr>`).join('')}</tbody>
            </table>` : '<div class="admin-empty">--- [ NO DATA ] ---</div>'}

        <div class="pnl-section">Expenses</div>
        <form class="expense-form" id="admExpenseForm">
            <input class="search-input" name="label" placeholder="Label (e.g. Shirt printing batch)" maxlength="120" required>
            <select class="search-input" name="category">${EXPENSE_CATEGORIES.map((c) => `<option value="${c}">${c.toUpperCase()}</option>`).join('')}</select>
            <input class="search-input" name="amount" type="number" min="0" step="0.01" placeholder="₱ Amount" required>
            <input class="search-input" name="spentOn" type="date" value="${today}">
            <button class="btn btn-blue" type="submit">Log</button>
        </form>
        ${d.expenses.length ? `
            <table class="admin-table">
                <thead><tr><th>Date</th><th>Label</th><th>Category</th><th class="num">Amount</th><th></th></tr></thead>
                <tbody>${d.expenses.map((e) => `<tr><td>${fmtDate(e.spentOn)}</td><td>${escapeHtml(e.label)}</td><td>${escapeHtml(e.category).toUpperCase()}</td><td class="num accent">${peso(e.amount)}</td><td class="num"><button class="admin-x" data-expense="${escapeHtml(e.id)}">X</button></td></tr>`).join('')}</tbody>
            </table>` : '<div class="admin-empty">--- [ NO EXPENSES LOGGED ] ---</div>'}`;
}

function downloadCsv(filename, header, rows) {
    const cell = (v) => {
        let s = v === null || v === undefined ? '' : String(v);
        if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = `\uFEFF${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportPnlCsv() {
    if (!lastPnl) { toast('Open a range first'); return; }
    const s = lastPnl.summary;
    const rows = [
        ['summary', 'revenue', s.revenue], ['summary', 'cost_of_goods', s.cogs], ['summary', 'expenses', s.expenses],
        ['summary', 'gross_profit', s.grossProfit], ['summary', 'net_profit', s.netProfit], ['summary', 'discounts', s.discounts],
        ['summary', 'shipping_collected', s.shippingCollected], ['summary', 'orders', s.orders], ['summary', 'units', s.units],
        ...lastPnl.timeline.map((t) => [`period ${new Date(t.period).toISOString().slice(0, 10)}`, 'revenue / cogs / expenses / profit', `${t.revenue} / ${t.cogs} / ${t.expenses} / ${t.profit}`]),
        ...lastPnl.expenses.map((e) => [`expense ${String(e.spentOn).slice(0, 10)}`, `${e.category}: ${e.label}`, e.amount]),
    ];
    downloadCsv(`paradigm-pnl-${lastPnl.range}.csv`, ['section', 'metric', 'value'], rows);
}

async function onExpenseSubmit(e) {
    if (e.target.id !== 'admExpenseForm') return;
    e.preventDefault();
    const f = new FormData(e.target);
    const { ok } = await api('/api/admin/expenses', {
        method: 'POST',
        body: { label: f.get('label'), category: f.get('category'), amount: f.get('amount'), spentOn: f.get('spentOn') },
    });
    if (ok) { playSound('success'); toast('Expense logged'); loadPnl(); }
    else { playSound('error'); toast('Could not log expense', 'error'); }
}

async function onPnlClick(e) {
    const del = e.target.closest('[data-expense]');
    if (!del) return;
    playSound();
    if (!(await confirmDialog('Delete Expense?', 'This expense entry will be removed from the ledger.', 'Delete'))) return;
    const { ok } = await api(`/api/admin/expenses/${del.dataset.expense}`, { method: 'DELETE' });
    if (ok) { toast('Expense removed'); loadPnl(); }
    else { playSound('error'); toast('Delete failed', 'error'); }
}

// ---------- Orders menu ----------
async function openOrders() {
    playSound();
    openModal('admOrdersModal');
    $('admOrderList').innerHTML = '<div class="admin-empty">Retrieving manifests...</div>';
    const { ok, data } = await api('/api/admin/orders');
    if (!ok) { $('admOrderList').innerHTML = '<div class="admin-empty">--- [ ORDERS OFFLINE ] ---</div>'; return; }
    adminOrders = data.orders;
    renderOrders();
}

const addressText = (a) => (a ? [a.name, a.line1, a.line2, a.city, a.province, a.postalCode, a.country].filter(Boolean).join(', ') : '');

function renderOrders() {
    const q = $('admOrderSearch').value.trim().toLowerCase().replace(/^#/, '');
    const list = adminOrders
        .filter((o) => orderFilter === 'all' || o.status === orderFilter)
        .filter((o) => !q
            || String(o.id).includes(q)
            || o.customer.email.toLowerCase().includes(q)
            || o.customer.name.toLowerCase().includes(q)
            || (o.customer.fullName || '').toLowerCase().includes(q)
            || (o.trackingNumber || '').toLowerCase().includes(q)
            || o.items.some((i) => i.title.toLowerCase().includes(q)));

    const groups = new Map();
    for (const o of list) {
        const key = o.customer.userId || `deleted:${o.customer.email}`;
        if (!groups.has(key)) groups.set(key, { customer: o.customer, orders: [] });
        groups.get(key).orders.push(o);
    }
    const customers = [...groups.values()].sort((a, b) => new Date(b.orders[0].createdAt) - new Date(a.orders[0].createdAt));
    const value = list.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + o.total, 0);
    $('admOrderSummary').textContent = `${customers.length} customer(s) · ${list.length} order(s) · ${peso(value)} (excluding cancelled)`;

    if (!customers.length) { $('admOrderList').innerHTML = '<div class="admin-empty">--- [ NO MATCHING ORDERS ] ---</div>'; return; }

    $('admOrderList').innerHTML = customers.map(({ customer: c, orders }) => {
        const spent = orders.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + o.total, 0);
        return `
            <div class="cust-card" data-cust="${escapeHtml(c.userId || c.email)}">
                <div class="cust-head" data-toggle>
                    <span class="cust-name">${escapeHtml(c.fullName || c.name)}${c.accountDeleted ? ' <span class="status-badge status-cancelled">account deleted</span>' : ''}<span class="cust-mail">${escapeHtml(c.email)}</span></span>
                    <span class="cust-meta">Last order ${fmtDate(orders[0].createdAt)}</span>
                    <span class="cust-meta">${orders.length} order(s)</span>
                    <span class="cust-total">${peso(spent)}</span>
                    <span class="caret">►</span>
                </div>
                <div class="cust-body">${orders.map(orderBlock).join('')}</div>
            </div>`;
    }).join('');
}

function orderBlock(o) {
    const openReturn = o.returns?.find((r) => ['requested', 'approved'].includes(r.status));
    return `
        <div class="aorder" data-order="${escapeHtml(o.id)}">
            <div class="aorder-head" data-toggle>
                <span>#${escapeHtml(o.id)}${openReturn ? ' ↺' : ''}</span>
                <span>${fmtDateTime(o.createdAt)}</span>
                <span class="status-badge status-${escapeHtml(o.status)}">${escapeHtml(o.status)}</span>
                <span class="text-right text-accent">${peso(o.total)}</span>
                <span class="caret">►</span>
            </div>
            <div class="aorder-body">
                <div class="cust-info">
                    SHIP TO: ${escapeHtml(addressText(o.shippingAddress) || '—')}<br>
                    CONTACT: ${escapeHtml(o.contactPhone || o.customer.phone || '—')} · PAYMENT: ${escapeHtml(o.paymentMethod === 'cod' ? 'Cash on Delivery' : o.paymentMethod)}
                    ${o.notes ? `<br>NOTES: ${escapeHtml(o.notes)}` : ''}
                    ${openReturn ? `<br><span class="text-[#e0a84a]">${escapeHtml(openReturn.kind.toUpperCase())} ${escapeHtml(openReturn.status.toUpperCase())}: ${escapeHtml(openReturn.reason)}</span>` : ''}
                </div>
                ${o.items.map((i) => `<div class="aorder-line"><span>${escapeHtml(i.title)} <span class="text-[#666] font-mono">${escapeHtml(i.size)}${i.color ? ` · ${escapeHtml(i.color)}` : ''} ×${i.quantity} @ ${peso(i.unitPrice)} · cost ${peso(i.unitCost)}${i.isPreorder ? ' · PRE-ORDER' : ''}</span></span><span>${peso(i.lineTotal)}</span></div>`).join('')}
                <div class="aorder-line"><span class="text-[#666] font-mono">SUBTOTAL ${peso(o.subtotal)}${o.bundleDiscount ? ` · BUNDLE −${peso(o.bundleDiscount)}` : ''}${o.discount ? ` · ${escapeHtml(o.discountCode || 'CODE')} −${peso(o.discount)}` : ''} · SHIPPING ${o.shippingFee ? peso(o.shippingFee) : 'FREE'}</span><span>${peso(o.total)}</span></div>
                <div class="aorder-actions">
                    <input class="search-input" data-courier placeholder="Courier (e.g. J&T, LBC)" value="${escapeHtml(o.courier)}" maxlength="60">
                    <input class="search-input" data-tracking placeholder="Tracking number" value="${escapeHtml(o.trackingNumber)}" maxlength="80">
                    <select class="search-input" data-status-select ${o.status === 'cancelled' ? 'disabled' : ''}>${STATUSES.map((s) => `<option value="${s}"${s === o.status ? ' selected' : ''}>${s.toUpperCase()}</option>`).join('')}</select>
                    <button class="btn btn-blue" data-order-save>Update</button>
                    <a class="btn" href="Receipt.html?order=${escapeHtml(o.id)}" target="_blank">Receipt</a>
                </div>
                <p class="admin-note mt-2">${o.itemCount} item(s) · updated ${fmtDateTime(o.updatedAt)}${o.status === 'cancelled' ? ' · cancelled orders cannot be reopened' : ''}</p>
            </div>
        </div>`;
}

async function onOrdersClick(e) {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) { playSound(); toggle.parentElement.classList.toggle('is-open'); return; }
    const save = e.target.closest('[data-order-save]');
    if (!save) return;
    const block = save.closest('[data-order]');
    const id = block.dataset.order;
    const order = adminOrders.find((o) => String(o.id) === id);
    if (!order) return;
    const body = {
        courier: block.querySelector('[data-courier]').value,
        trackingNumber: block.querySelector('[data-tracking]').value,
    };
    const status = block.querySelector('[data-status-select]').value;
    if (status !== order.status) body.status = status;
    if (body.status === 'cancelled'
        && !(await confirmDialog(`Cancel Order #${id}?`, 'Stock goes back to inventory and the order is excluded from sales. This cannot be undone.', 'Cancel Order'))) return;

    save.disabled = true;
    const { ok, data } = await api(`/api/admin/orders/${id}`, { method: 'PATCH', body });
    save.disabled = false;
    if (!ok) { playSound('error'); toast(`Update failed: ${errText(data)}`, 'error'); return; }

    const openOrderIds = [...document.querySelectorAll('#admOrderList .aorder.is-open')].map((el) => el.dataset.order);
    const openCustomers = [...document.querySelectorAll('#admOrderList .cust-card.is-open')].map((el) => el.dataset.cust);
    adminOrders = adminOrders.map((o) => (String(o.id) === id ? data.order : o));
    renderOrders();
    openCustomers.forEach((c) => document.querySelector(`#admOrderList .cust-card[data-cust="${CSS.escape(c)}"]`)?.classList.add('is-open'));
    openOrderIds.forEach((oid) => document.querySelector(`#admOrderList .aorder[data-order="${CSS.escape(oid)}"]`)?.classList.add('is-open'));
    playSound('success');
    toast(`Order #${id} updated`);
    if (body.status === 'cancelled') refreshProducts();
}

// ---------- Returns ----------
async function openReturns() {
    playSound();
    openModal('admReturnsModal');
    $('admReturnsList').innerHTML = '<div class="admin-empty">Loading...</div>';
    const { ok, data } = await api('/api/admin/orders/returns');
    if (!ok) { $('admReturnsList').innerHTML = '<div class="admin-empty">--- [ OFFLINE ] ---</div>'; return; }
    $('admReturnsList').innerHTML = data.returns.length ? data.returns.map((r) => `
        <div class="aorder is-open" data-return="${escapeHtml(r.id)}">
            <div class="aorder-head">
                <span>#${escapeHtml(r.orderId)} · ${escapeHtml(r.kind.toUpperCase())}</span>
                <span>${escapeHtml(r.customerName)} · ${escapeHtml(r.customerEmail)}</span>
                <span class="status-badge status-${r.status === 'requested' ? 'pending' : r.status === 'rejected' ? 'cancelled' : 'completed'}">${escapeHtml(r.status)}</span>
                <span class="text-right">${fmtDate(r.createdAt)}</span><span></span>
            </div>
            <div class="aorder-body">
                <div class="cust-info">REASON: ${escapeHtml(r.reason)}${r.details ? `<br>DETAILS: ${escapeHtml(r.details)}` : ''}<br>ORDER TOTAL: ${peso(r.orderTotal)}</div>
                <div class="aorder-actions">
                    <input class="search-input flex-1" data-note placeholder="Note to customer (shown on their order)" value="${escapeHtml(r.adminNote)}" maxlength="500">
                    <select class="search-input" data-return-status>${RETURN_STATUSES.map((s) => `<option value="${s}"${s === r.status ? ' selected' : ''}>${s.toUpperCase()}</option>`).join('')}</select>
                    <button class="btn btn-blue" data-return-save>Save</button>
                </div>
            </div>
        </div>`).join('') : '<div class="admin-empty">--- [ NO RETURN REQUESTS ] ---</div>';
}

async function onReturnsClick(e) {
    const save = e.target.closest('[data-return-save]');
    if (!save) return;
    const block = save.closest('[data-return]');
    save.disabled = true;
    const { ok } = await api(`/api/admin/orders/returns/${block.dataset.return}`, {
        method: 'PATCH',
        body: { status: block.querySelector('[data-return-status]').value, adminNote: block.querySelector('[data-note]').value },
    });
    save.disabled = false;
    if (ok) { playSound('success'); toast('Return updated'); openReturns(); }
    else { playSound('error'); toast('Update failed', 'error'); }
}

// ---------- Customers ----------
let customers = [];
async function openCustomers() {
    playSound();
    openModal('admCustomersModal');
    const { ok, data } = await api('/api/admin/customers');
    if (!ok) { $('admCustomerList').innerHTML = '<div class="admin-empty">--- [ OFFLINE ] ---</div>'; return; }
    customers = data.customers;
    renderCustomers();
}
function renderCustomers() {
    const q = $('admCustomerSearch').value.trim().toLowerCase();
    const list = customers.filter((c) => !q || c.email.toLowerCase().includes(q) || c.username.toLowerCase().includes(q) || (c.fullName || '').toLowerCase().includes(q));
    const total = list.reduce((s, c) => s + c.spent, 0);
    $('admCustomerSummary').textContent = `${list.length} account(s) · ${list.filter((c) => c.orders > 0).length} buyer(s) · ${peso(total)} lifetime`;
    $('admCustomerList').innerHTML = list.length ? `
        <table class="admin-table">
            <thead><tr><th>Customer</th><th>Phone</th><th>Joined</th><th class="num">Orders</th><th class="num">Spent</th><th>Last Order</th><th class="num">Wishlist</th></tr></thead>
            <tbody>${list.map((c) => `<tr>
                <td>${escapeHtml(c.fullName || c.username)}${c.role === 'admin' ? ' <span class="role-badge is-admin">OWNER</span>' : ''}<br><span class="text-[#666] font-mono text-[10px]">${escapeHtml(c.email)}</span></td>
                <td class="font-mono">${escapeHtml(c.phone || '—')}</td><td>${fmtDate(c.joinedAt)}</td>
                <td class="num">${c.orders}</td><td class="num accent">${peso(c.spent)}</td><td>${fmtDate(c.lastOrderAt)}</td><td class="num">${c.wishlist}</td></tr>`).join('')}</tbody>
        </table>` : '<div class="admin-empty">--- [ NO CUSTOMERS ] ---</div>';
}

// ---------- Stock ----------
async function openStock() {
    playSound();
    openModal('admStockModal');
    const low = lowStockList().sort((a, b) => a.stock - b.stock);
    const { ok, data } = await api('/api/admin/products/restock-requests');
    const requests = ok ? data.requests : [];
    const grouped = new Map();
    for (const r of requests) {
        const key = `${r.productId}|${r.size}|${r.color}`;
        if (!grouped.has(key)) grouped.set(key, { ...r, emails: [] });
        grouped.get(key).emails.push(r.email);
    }
    $('admStockBody').innerHTML = `
        <div class="pnl-section">Low Stock · at or below ${storeSettings?.lowStockThreshold ?? 3}</div>
        ${low.length ? `<table class="admin-table">
            <thead><tr><th>Item</th><th>Colour</th><th>Size</th><th class="num">Stock</th><th></th></tr></thead>
            <tbody>${low.map((v) => `<tr><td>${escapeHtml(v.product.title)}${v.product.isActive === false ? ' <span class="text-[#666]">(hidden)</span>' : ''}</td><td>${escapeHtml(v.color || 'Default')}</td><td>${v.size}</td>
                <td class="num ${v.stock === 0 ? 'text-danger' : 'text-[#e0a84a]'}">${v.stock}</td><td class="num"><button class="admin-x is-blue" data-edit="${v.product.id}">EDIT</button></td></tr>`).join('')}</tbody>
        </table>` : '<div class="admin-empty">--- [ ALL SIZES WELL STOCKED ] ---</div>'}
        <div class="pnl-section">Restock Requests</div>
        <p class="admin-note mb-2.5">Customers asked to be notified. Automatic emails will be sent once an email service (Resend) is connected. For now, you can contact them directly.</p>
        ${grouped.size ? `<table class="admin-table">
            <thead><tr><th>Item</th><th>Size</th><th class="num">Requests</th><th>Emails</th></tr></thead>
            <tbody>${[...grouped.values()].map((g) => `<tr><td>${escapeHtml(g.title)}</td><td>${escapeHtml(g.size || 'Any')}${g.color ? ` · ${escapeHtml(g.color)}` : ''}</td><td class="num accent">${g.emails.length}</td><td class="font-mono text-[10px] break-all">${g.emails.map(escapeHtml).join(', ')}</td></tr>`).join('')}</tbody>
        </table>` : '<div class="admin-empty">--- [ NO REQUESTS ] ---</div>'}`;
}

// ---------- Discounts ----------
async function openDiscounts() {
    playSound();
    openModal('admDiscountsModal');
    loadDiscounts();
}
async function loadDiscounts() {
    const { ok, data } = await api('/api/admin/discounts');
    if (!ok) { $('admDiscountList').innerHTML = '<div class="admin-empty">--- [ OFFLINE ] ---</div>'; return; }
    $('admDiscountList').innerHTML = data.discounts.length ? `
        <table class="admin-table">
            <thead><tr><th>Code</th><th>Value</th><th class="num">Min</th><th class="num">Used</th><th>Expires</th><th>Status</th><th></th></tr></thead>
            <tbody>${data.discounts.map((d) => {
                const expired = d.expiresAt && new Date(d.expiresAt) < new Date();
                return `<tr>
                <td class="font-mono accent">${escapeHtml(d.code)}</td>
                <td>${d.kind === 'percent' ? `${d.value}% off` : `${peso(d.value)} off`}</td>
                <td class="num">${d.minSubtotal ? peso(d.minSubtotal) : '—'}</td>
                <td class="num">${d.usedCount}${d.maxUses ? ` / ${d.maxUses}` : ''}</td>
                <td>${d.expiresAt ? fmtDateTime(d.expiresAt) : 'Never'}</td>
                <td><span class="status-badge ${expired ? 'status-cancelled' : d.isActive ? 'status-completed' : 'status-pending'}">${expired ? 'expired' : d.isActive ? 'active' : 'paused'}</span></td>
                <td class="num"><button class="admin-x is-blue" data-code-toggle="${escapeHtml(d.code)}" data-active="${d.isActive}">${d.isActive ? 'PAUSE' : 'RESUME'}</button>
                    <button class="admin-x" data-code-del="${escapeHtml(d.code)}">X</button></td></tr>`;
            }).join('')}</tbody>
        </table>` : '<div class="admin-empty">--- [ NO CODES YET ] ---</div>';
}
async function onDiscountCreate(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = Object.fromEntries(f.entries());
    if (body.expiresAt) body.expiresAt = new Date(body.expiresAt).toISOString();
    const { ok, data } = await api('/api/admin/discounts', { method: 'POST', body });
    if (!ok) { playSound('error'); toast(`Could not create: ${errText(data)}`, 'error'); return; }
    playSound('success');
    toast(`${data.discount.code} created`);
    e.target.reset();
    loadDiscounts();
}
async function onDiscountClick(e) {
    const toggle = e.target.closest('[data-code-toggle]');
    const del = e.target.closest('[data-code-del]');
    if (toggle) {
        playSound();
        const { ok } = await api(`/api/admin/discounts/${encodeURIComponent(toggle.dataset.codeToggle)}`, { method: 'PATCH', body: { isActive: toggle.dataset.active !== 'true' } });
        ok ? loadDiscounts() : toast('Update failed', 'error');
    } else if (del) {
        playSound();
        if (!(await confirmDialog(`Delete ${del.dataset.codeDel}?`, 'Customers will no longer be able to use this code. Past orders keep their discount.', 'Delete'))) return;
        const { ok } = await api(`/api/admin/discounts/${encodeURIComponent(del.dataset.codeDel)}`, { method: 'DELETE' });
        ok ? (toast('Code deleted'), loadDiscounts()) : toast('Delete failed', 'error');
    }
}

// ---------- Inbox (contact messages + newsletter) ----------
function openInbox() {
    playSound();
    openModal('admInboxModal');
    document.querySelectorAll('#admInboxTabs .chip').forEach((c) => c.classList.toggle('active', c.dataset.inbox === 'messages'));
    loadInbox('messages');
}
async function loadInbox(tab) {
    const body = $('admInboxBody');
    body.innerHTML = '<div class="admin-empty">Loading...</div>';
    if (tab === 'messages') {
        const { ok, data } = await api('/api/admin/messages');
        if (!ok) { body.innerHTML = '<div class="admin-empty">--- [ OFFLINE ] ---</div>'; return; }
        body.innerHTML = data.messages.length ? data.messages.map((m) => `
            <div class="aorder is-open${m.isRead ? ' opacity-60' : ''}" data-msg="${escapeHtml(m.id)}">
                <div class="aorder-head">
                    <span>${m.isRead ? '' : '● '}${escapeHtml(m.subject || '(no subject)')}</span>
                    <span>${escapeHtml(m.name)} · ${escapeHtml(m.email)}</span><span></span>
                    <span class="text-right">${fmtDateTime(m.createdAt)}</span><span></span>
                </div>
                <div class="aorder-body">
                    <div class="review-body mb-2.5">${escapeHtml(m.message)}</div>
                    <div class="aorder-actions">
                        <a class="btn btn-blue" href="mailto:${encodeURIComponent(m.email)}?subject=${encodeURIComponent(`Re: ${m.subject || 'Your message to Paradigm'}`)}">Reply by Email</a>
                        <button class="btn" data-msg-read="${m.isRead ? 'false' : 'true'}">${m.isRead ? 'Mark Unread' : 'Mark Read'}</button>
                        <button class="btn btn-danger" data-msg-del>Delete</button>
                    </div>
                </div>
            </div>`).join('') : '<div class="admin-empty">--- [ NO MESSAGES ] ---</div>';
    } else {
        const { ok, data } = await api('/api/admin/subscribers');
        if (!ok) { body.innerHTML = '<div class="admin-empty">--- [ OFFLINE ] ---</div>'; return; }
        body.innerHTML = `
            <div class="admin-toolbar"><span class="admin-note mr-auto self-center">${data.subscribers.length} subscriber(s)</span>
                <a class="btn btn-auto" href="/api/admin/subscribers.csv" download>⇩ Export CSV</a></div>
            ${data.subscribers.length ? `<table class="admin-table"><thead><tr><th>Email</th><th>Subscribed</th><th></th></tr></thead>
                <tbody>${data.subscribers.map((s) => `<tr><td class="font-mono">${escapeHtml(s.email)}</td><td>${fmtDate(s.createdAt)}</td><td class="num"><button class="admin-x" data-sub-del="${escapeHtml(s.email)}">X</button></td></tr>`).join('')}</tbody></table>`
                : '<div class="admin-empty">--- [ NO SUBSCRIBERS YET ] ---</div>'}`;
    }
}
async function onInboxClick(e) {
    const msg = e.target.closest('[data-msg]');
    const read = e.target.closest('[data-msg-read]');
    const del = e.target.closest('[data-msg-del]');
    const sub = e.target.closest('[data-sub-del]');
    if (read && msg) {
        playSound();
        await api(`/api/admin/messages/${msg.dataset.msg}`, { method: 'PATCH', body: { isRead: read.dataset.msgRead === 'true' } });
        loadInbox('messages');
    } else if (del && msg) {
        playSound();
        if (!(await confirmDialog('Delete Message?', 'This message will be permanently removed.', 'Delete'))) return;
        await api(`/api/admin/messages/${msg.dataset.msg}`, { method: 'DELETE' });
        loadInbox('messages');
    } else if (sub) {
        playSound();
        if (!(await confirmDialog('Remove Subscriber?', `${sub.dataset.subDel} will be removed from the newsletter list.`, 'Remove'))) return;
        await api(`/api/admin/subscribers/${encodeURIComponent(sub.dataset.subDel)}`, { method: 'DELETE' });
        loadInbox('subscribers');
    }
}

// ---------- Store settings ----------
async function openSettings() {
    playSound();
    openModal('admSettingsModal');
    const { ok, data } = await api('/api/admin/settings');
    if (!ok) { $('admSettingsBody').innerHTML = '<div class="admin-empty">--- [ OFFLINE ] ---</div>'; return; }
    storeSettings = data.settings;
    const s = storeSettings;
    const f = (label, name, value, type = 'number', extra = '') => `<div class="admin-field"><label>${label}</label><input class="search-input" name="${name}" type="${type}" value="${escapeHtml(value ?? '')}" ${extra}></div>`;
    $('admSettingsBody').innerHTML = `
        <form id="admSettingsForm">
            <div class="pnl-section">Shipping</div>
            <div class="admin-row">
                ${f('Flat Shipping Fee (₱)', 'shippingFee', s.shippingFee, 'number', 'min="0" step="0.01"')}
                ${f('Free Shipping From (₱, 0 = never)', 'freeShippingMin', s.freeShippingMin, 'number', 'min="0" step="0.01"')}
            </div>
            <div class="pnl-section">Bundle Deal</div>
            <div class="admin-row">
                ${f('Items Needed (0 = off)', 'bundleMinQty', s.bundleMinQty, 'number', 'min="0" step="1"')}
                ${f('% Off Subtotal', 'bundlePercent', s.bundlePercent, 'number', 'min="0" max="90" step="0.5"')}
            </div>
            <p class="admin-note">Example: 2 items and 10% = buy any 2+ tees, get 10% off the cart.</p>
            <div class="pnl-section">Announcement Banner</div>
            ${f('Text (blank = hidden)', 'announcement', s.announcement, 'text', 'maxlength="160" placeholder="e.g. NEW DROP · FRIDAY 8PM"')}
            ${f('Countdown To (optional)', 'announcementUntil', toLocalInput(s.announcementUntil), 'datetime-local')}
            <div class="pnl-section">Social Links</div>
            ${f('Instagram URL', 'instagram', s.social.instagram, 'url', 'placeholder="https://instagram.com/..."')}
            ${f('TikTok URL', 'tiktok', s.social.tiktok, 'url', 'placeholder="https://tiktok.com/@..."')}
            ${f('Facebook URL', 'facebook', s.social.facebook, 'url', 'placeholder="https://facebook.com/..."')}
            <div class="pnl-section">Alerts</div>
            ${f('Low-Stock Warning At', 'lowStockThreshold', s.lowStockThreshold, 'number', 'min="0" step="1"')}
            <button class="btn btn-blue mt-5" type="submit">Save Settings</button>
        </form>`;
}
async function onSettingsSubmit(e) {
    if (e.target.id !== 'admSettingsForm') return;
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target).entries());
    const body = {
        shippingFee: f.shippingFee || 0,
        freeShippingMin: f.freeShippingMin || 0,
        bundleMinQty: Number(f.bundleMinQty || 0),
        bundlePercent: f.bundlePercent || 0,
        announcement: f.announcement,
        announcementUntil: f.announcementUntil ? new Date(f.announcementUntil).toISOString() : null,
        lowStockThreshold: Number(f.lowStockThreshold || 0),
        social: { instagram: f.instagram, tiktok: f.tiktok, facebook: f.facebook },
    };
    const { ok, data } = await api('/api/admin/settings', { method: 'PUT', body });
    if (!ok) { playSound('error'); toast(`Save failed: ${errText(data)}`, 'error'); return; }
    storeSettings = data.settings;
    paintLowStockBadge();
    playSound('success');
    toast('Settings saved · live for shoppers within ~30s');
    closeModal('admSettingsModal');
}

// ---------- Deleted records ----------
async function openDeleted() {
    playSound();
    openModal('admDeletedModal');
    const { ok, data } = await api('/api/admin/products/deleted');
    if (!ok) { $('admDeletedList').innerHTML = '<div class="admin-empty">--- [ RECORDS OFFLINE ] ---</div>'; return; }
    $('admDeletedList').innerHTML = data.deleted.length ? `
        <table class="admin-table">
            <thead><tr><th>Record</th><th>Item</th><th class="num">Price</th><th>Reason</th><th>Deleted</th></tr></thead>
            <tbody>${data.deleted.map((d) => `<tr><td>#${escapeHtml(d.archiveId)}</td><td>${escapeHtml(d.title)} <span class="text-[#666] font-mono">(item ${d.productId}${d.hasImage ? ' · photo kept' : ''}${d.extraPhotos ? ` · +${d.extraPhotos} photos` : ''})</span></td><td class="num accent">${peso(d.price)}</td><td>${escapeHtml(d.reason || '—')}</td><td>${fmtDate(d.deletedAt)}<br><span class="text-[#666] font-mono text-[9px]">${escapeHtml(d.deletedBy || '')}</span></td></tr>`).join('')}</tbody>
        </table>` : '<div class="admin-empty">--- [ NO DELETED ITEMS ] ---</div>';
}
