// Owner console for the archive page. index.html only imports this for role === 'admin',
// and every request it makes is checked again by the server (/api/admin requires the admin role).
import { api } from './auth.js';
import { escapeHtml, peso, playSound, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const fmtDate = (d) => new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const STATUSES = ['pending', 'paid', 'shipped', 'completed', 'cancelled'];
const EXPENSE_CATEGORIES = ['production', 'shipping', 'packaging', 'marketing', 'platform', 'other'];

let ctx;               // { getProducts, setProducts }
let editing = null;    // product being edited, or { isNew: true }
let pendingImage = null;
let pnlRange = '30d';
let adminOrders = [];
let orderFilter = 'all';

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

    // The public product list is CDN-cached for a few seconds; the owner always sees the live list with costs.
    await refreshProducts();
}

async function refreshProducts() {
    const { ok, data } = await api('/api/admin/products');
    if (ok) ctx.setProducts(data.products);
}

function injectConsole() {
    const bar = document.createElement('div');
    bar.className = 'admin-console';
    bar.innerHTML = `
        <div class="admin-console-inner">
            <span class="admin-console-label">◆ Owner Console</span>
            <button class="btn" id="admNewBtn">＋ New Item</button>
            <button class="btn btn-blue" id="admPnlBtn">P&amp;L Tracker</button>
            <button class="btn btn-blue" id="admOrdersBtn">Orders Menu</button>
            <button class="btn" id="admDeletedBtn">Deleted Records</button>
        </div>`;
    document.querySelector('.filter-wrapper').after(bar);
    $('admNewBtn').addEventListener('click', () => openEditor(null));
    $('admPnlBtn').addEventListener('click', openPnl);
    $('admOrdersBtn').addEventListener('click', openOrders);
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
                <div class="admin-photo" id="admPhoto"><img id="admPhotoImg" alt=""><div class="admin-photo-hint">Click to replace image</div></div>
                <input type="file" id="admPhotoInput" accept="image/png,image/jpeg,image/webp" hidden>
                <div class="admin-fields">
                    <div class="admin-field"><label for="admTitle">Name</label><input class="search-input" id="admTitle" maxlength="80"></div>
                    <div class="admin-field"><label for="admDesc">Description</label><textarea class="search-input" id="admDesc" maxlength="2000"></textarea></div>
                    <div class="admin-row">
                        <div class="admin-field"><label for="admPrice">Price (₱)</label><input class="search-input" id="admPrice" type="number" min="0" step="0.01"></div>
                        <div class="admin-field"><label for="admCost">Unit Cost (₱) · owner only</label><input class="search-input" id="admCost" type="number" min="0" step="0.01"></div>
                    </div>
                    <div class="admin-margin" id="admMargin"></div>
                    <div class="admin-row mt-auto">
                        <button class="btn btn-danger" id="admDeleteBtn">Delete Item</button>
                        <button class="btn btn-blue" id="admSaveBtn">Save Changes</button>
                    </div>
                    <p class="admin-note" id="admEditStatus"></p>
                </div>
            </div>`),
        modal('admDeleteModal', `
            <h2 class="admin-h2 is-danger">Delete <span id="admDeleteName"></span>?</h2>
            <p class="admin-text">The item will be removed from the shop and from every wishlist.<br>A full copy (with its photo) is kept in the backend deleted records.</p>
            <div class="admin-field mb-[15px]"><label for="admDeleteReason">Reason (optional)</label><input class="search-input" id="admDeleteReason" maxlength="300"></div>
            <div class="admin-field mb-5"><label for="admDeleteConfirm">Type DELETE to confirm</label><input class="search-input" id="admDeleteConfirm" autocomplete="off"></div>
            <div class="admin-row">
                <button class="btn" data-adm-close="admDeleteModal">Cancel</button>
                <button class="btn btn-danger" id="admDeleteConfirmBtn" disabled>Delete Permanently</button>
            </div>`, ''),
        modal('admPnlModal', `
            <h2 class="admin-h2">Profit &amp; Loss Tracker</h2>
            <div class="chip-row justify-center" id="admPnlRanges">
                ${['7d', '30d', '90d', '12m', 'all'].map(r => `<button class="chip${r === pnlRange ? ' active' : ''}" data-range="${r}">${r === 'all' ? 'All Time' : r.toUpperCase()}</button>`).join('')}
            </div>
            <div id="admPnlBody"><div class="admin-empty">Computing ledger...</div></div>`, 'admin-wide'),
        modal('admOrdersModal', `
            <h2 class="admin-h2">Orders Menu</h2>
            <div class="admin-toolbar"><input class="search-input" id="admOrderSearch" placeholder="Search customer, email, order # or item..."></div>
            <div class="chip-row mb-5" id="admOrderFilters">
                ${['all', ...STATUSES].map(s => `<button class="chip${s === 'all' ? ' active' : ''}" data-status="${s}">${s}</button>`).join('')}
            </div>
            <div class="admin-note mb-2.5" id="admOrderSummary"></div>
            <div id="admOrderList"><div class="admin-empty">Retrieving manifests...</div></div>`, 'admin-wide'),
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

    // Editor events
    $('admPhoto').addEventListener('click', () => { playSound(); $('admPhotoInput').click(); });
    $('admPhotoInput').addEventListener('change', onPhotoPicked);
    ['admPrice', 'admCost'].forEach(id => $(id).addEventListener('input', paintMargin));
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

    // P&L events
    $('admPnlRanges').addEventListener('click', (e) => {
        const chip = e.target.closest('[data-range]');
        if (!chip) return;
        playSound();
        pnlRange = chip.dataset.range;
        document.querySelectorAll('#admPnlRanges .chip').forEach(c => c.classList.toggle('active', c === chip));
        loadPnl();
    });
    $('admPnlBody').addEventListener('click', onPnlClick);
    $('admPnlBody').addEventListener('submit', onExpenseSubmit);

    // Orders events
    $('admOrderSearch').addEventListener('input', renderOrders);
    $('admOrderFilters').addEventListener('click', (e) => {
        const chip = e.target.closest('[data-status]');
        if (!chip) return;
        playSound();
        orderFilter = chip.dataset.status;
        document.querySelectorAll('#admOrderFilters .chip').forEach(c => c.classList.toggle('active', c === chip));
        renderOrders();
    });
    $('admOrderList').addEventListener('click', onOrdersClick);
}

const openModal = (id) => $(id).classList.add('active');
const closeModal = (id) => $(id).classList.remove('active');

// ---------- Product editor ----------
function openEditor(id) {
    playSound();
    pendingImage = null;
    $('admPhotoInput').value = '';
    if (id === null) {
        editing = { isNew: true, title: '', desc: '', price: '', cost: '', image: null };
    } else {
        const p = ctx.getProducts().find(x => x.id === id);
        if (!p) return;
        editing = { ...p };
    }
    $('admEditTitle').textContent = editing.isNew ? 'Register New Artifact' : `Edit Artifact #${editing.id}`;
    $('admTitle').value = editing.title;
    $('admDesc').value = editing.desc;
    $('admPrice').value = editing.price;
    $('admCost').value = editing.cost ?? '';
    $('admDeleteBtn').hidden = Boolean(editing.isNew);
    $('admSaveBtn').textContent = editing.isNew ? 'Publish Item' : 'Save Changes';
    $('admEditStatus').textContent = editing.isNew ? 'A photo is required for new items.' : '';
    paintPhoto(editing.image);
    paintMargin();
    openModal('admEditModal');
}

function paintPhoto(src) {
    $('admPhoto').classList.toggle('is-empty', !src);
    $('admPhotoImg').src = src || 'https://placehold.co/800?text=Upload+Image';
}

function paintMargin() {
    const price = Number.parseFloat($('admPrice').value) || 0;
    const cost = Number.parseFloat($('admCost').value) || 0;
    const profit = price - cost;
    const el = $('admMargin');
    el.classList.toggle('is-neg', profit < 0);
    el.innerHTML = price > 0
        ? `Profit per unit: <b>${peso(profit)}</b> · Margin: <b>${Math.round((profit / price) * 100)}%</b>`
        : 'Set a price to see margin.';
}

// Resize in the browser to max 1600px WebP (keeps uploads well under the server limit).
async function resizeImage(file, maxSide = 1600) {
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
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 25 * 1024 * 1024) {
        playSound('error'); toast('Use a PNG, JPG or WEBP under 25 MB', 'error'); return;
    }
    try {
        $('admEditStatus').textContent = 'Processing image...';
        pendingImage = await resizeImage(file);
        paintPhoto(pendingImage);
        $('admEditStatus').textContent = 'New image ready. Save to apply.';
    } catch {
        playSound('error'); toast('Could not process that image', 'error');
        $('admEditStatus').textContent = '';
    }
}

async function saveProduct() {
    const btn = $('admSaveBtn');
    if (btn.disabled) return;
    const body = {
        title: $('admTitle').value.trim(),
        desc: $('admDesc').value.trim(),
        price: $('admPrice').value,
        cost: $('admCost').value || 0,
    };
    if (!body.title) { playSound('error'); toast('Name is required', 'error'); return; }
    if (!(Number.parseFloat(body.price) >= 0)) { playSound('error'); toast('Enter a valid price', 'error'); return; }
    if (editing.isNew && !pendingImage) { playSound('error'); toast('Upload a photo first', 'error'); return; }
    if (pendingImage) body.image = pendingImage;

    btn.disabled = true;
    $('admEditStatus').textContent = 'Transmitting...';
    const { ok, data } = editing.isNew
        ? await api('/api/admin/products', { method: 'POST', body })
        : await api(`/api/admin/products/${editing.id}`, { method: 'PATCH', body });
    btn.disabled = false;

    if (!ok) {
        playSound('error');
        $('admEditStatus').textContent = '';
        toast(`Save failed: ${(data.error || 'error').replace(/_/g, ' ')}`, 'error');
        return;
    }
    const products = ctx.getProducts();
    ctx.setProducts(editing.isNew
        ? [data.product, ...products]
        : products.map(p => (p.id === data.product.id ? { ...p, ...data.product } : p)));
    playSound('success');
    toast(editing.isNew ? 'Item published' : 'Item updated');
    closeModal('admEditModal');
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
        toast(`Delete failed: ${(data.error || 'error').replace(/_/g, ' ')}`, 'error');
        return;
    }
    ctx.setProducts(ctx.getProducts().filter(p => p.id !== editing.id));
    closeModal('admDeleteModal');
    closeModal('admEditModal');
    playSound('purge');
    toast(`Item deleted · archived as record #${data.archiveId}`);
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
    const max = Math.max(1, ...d.timeline.map(t => Math.max(t.revenue, Math.abs(t.profit))));
    const today = new Date().toISOString().slice(0, 10);

    $('admPnlBody').innerHTML = `
        <div class="pnl-stats">
            ${stat('Gross Sales (realized)', peso(s.revenue))}
            ${stat('Cost of Goods', peso(s.cogs))}
            ${stat('Other Expenses', peso(s.expenses))}
            ${stat('Net Profit / Loss', peso(s.netProfit), sign(s.netProfit))}
            ${stat('Gross Profit', peso(s.grossProfit), sign(s.grossProfit))}
            ${stat('Net Margin', s.margin === null ? '—' : `${(s.margin * 100).toFixed(1)}%`, sign(s.margin ?? 0))}
            ${stat('Orders · Units', `${s.orders} · ${s.units}`)}
            ${stat(`Pending (${s.pendingOrders} orders)`, peso(s.pendingRevenue))}
        </div>
        <p class="admin-note">Sales count orders marked paid, shipped or completed. Pending orders are shown separately; cancelled orders are excluded. Set each item's unit cost in its editor for accurate profit.</p>

        <div class="pnl-section">Timeline · per ${d.bucket}</div>
        ${d.timeline.length ? `
            <div class="pnl-chart">
                ${d.timeline.map(t => `
                    <div class="pnl-bar-group" title="${bucketLabel(t.period, d.bucket)} · Sales ${peso(t.revenue)} · Profit ${peso(t.profit)}">
                        <div class="pnl-bars">
                            <div class="pnl-bar rev" style="height:${(t.revenue / max) * 100}%"></div>
                            <div class="pnl-bar pro${t.profit < 0 ? ' is-neg' : ''}" style="height:${(Math.abs(t.profit) / max) * 100}%"></div>
                        </div>
                        <div class="pnl-bar-label">${bucketLabel(t.period, d.bucket)}</div>
                    </div>`).join('')}
            </div>
            <div class="pnl-legend"><span><i class="bg-accent"></i>Sales</span><span><i class="bg-[#34d399]"></i>Profit</span><span><i class="bg-danger"></i>Loss</span></div>
        ` : '<div class="admin-empty">--- [ NO SALES IN THIS RANGE ] ---</div>'}

        <div class="pnl-section">Top Items</div>
        ${d.topProducts.length ? `
            <table class="admin-table">
                <thead><tr><th>Item</th><th class="num">Units</th><th class="num">Sales</th><th class="num">Profit</th></tr></thead>
                <tbody>${d.topProducts.map(p => `<tr><td>${escapeHtml(p.title)}</td><td class="num">${p.units}</td><td class="num accent">${peso(p.revenue)}</td><td class="num">${peso(p.profit)}</td></tr>`).join('')}</tbody>
            </table>` : '<div class="admin-empty">--- [ NO DATA ] ---</div>'}

        <div class="pnl-section">Expenses</div>
        <form class="expense-form" id="admExpenseForm">
            <input class="search-input" name="label" placeholder="Label (e.g. Shirt printing batch)" maxlength="120" required>
            <select class="search-input" name="category">${EXPENSE_CATEGORIES.map(c => `<option value="${c}">${c.toUpperCase()}</option>`).join('')}</select>
            <input class="search-input" name="amount" type="number" min="0" step="0.01" placeholder="₱ Amount" required>
            <input class="search-input" name="spentOn" type="date" value="${today}">
            <button class="btn btn-blue" type="submit">Log</button>
        </form>
        ${d.expenses.length ? `
            <table class="admin-table">
                <thead><tr><th>Date</th><th>Label</th><th>Category</th><th class="num">Amount</th><th></th></tr></thead>
                <tbody>${d.expenses.map(e => `<tr><td>${fmtDate(e.spentOn)}</td><td>${escapeHtml(e.label)}</td><td>${escapeHtml(e.category).toUpperCase()}</td><td class="num accent">${peso(e.amount)}</td><td class="num"><button class="admin-x" data-expense="${escapeHtml(e.id)}">X</button></td></tr>`).join('')}</tbody>
            </table>` : '<div class="admin-empty">--- [ NO EXPENSES LOGGED ] ---</div>'}`;
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
    if (!window.confirm('Delete this expense entry?')) return;
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

function renderOrders() {
    const q = $('admOrderSearch').value.trim().toLowerCase().replace(/^#/, '');
    const list = adminOrders
        .filter(o => orderFilter === 'all' || o.status === orderFilter)
        .filter(o => !q
            || String(o.id).includes(q)
            || o.customer.email.toLowerCase().includes(q)
            || o.customer.name.toLowerCase().includes(q)
            || (o.customer.fullName || '').toLowerCase().includes(q)
            || o.items.some(i => i.title.toLowerCase().includes(q)));

    // Group by customer (account id, or email for deleted accounts).
    const groups = new Map();
    for (const o of list) {
        const key = o.customer.userId || `deleted:${o.customer.email}`;
        if (!groups.has(key)) groups.set(key, { customer: o.customer, orders: [] });
        groups.get(key).orders.push(o);
    }
    const customers = [...groups.values()].sort((a, b) => new Date(b.orders[0].createdAt) - new Date(a.orders[0].createdAt));
    const value = list.filter(o => o.status !== 'cancelled').reduce((s, o) => s + o.total, 0);
    $('admOrderSummary').textContent = `${customers.length} customer(s) · ${list.length} order(s) · ${peso(value)} (excluding cancelled)`;

    if (!customers.length) { $('admOrderList').innerHTML = '<div class="admin-empty">--- [ NO MATCHING ORDERS ] ---</div>'; return; }

    $('admOrderList').innerHTML = customers.map(({ customer: c, orders }) => {
        const spent = orders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + o.total, 0);
        const a = c.shippingAddress;
        const address = a ? [a.line1, a.line2, a.city, a.province, a.postalCode, a.country].filter(Boolean).join(', ') : '';
        return `
            <div class="cust-card">
                <div class="cust-head" data-toggle>
                    <span class="cust-name">${escapeHtml(c.fullName || c.name)}${c.accountDeleted ? ' <span class="status-badge status-cancelled">account deleted</span>' : ''}<span class="cust-mail">${escapeHtml(c.email)}</span></span>
                    <span class="cust-meta">Last order ${fmtDate(orders[0].createdAt)}</span>
                    <span class="cust-meta">${orders.length} order(s)</span>
                    <span class="cust-total">${peso(spent)}</span>
                    <span class="caret">►</span>
                </div>
                <div class="cust-body">
                    <div class="cust-info">
                        DISPLAY NAME: ${escapeHtml(c.name)}<br>
                        PHONE: ${escapeHtml(c.phone || '—')}<br>
                        SHIP TO: ${escapeHtml(address || '—')}
                    </div>
                    ${orders.map(orderBlock).join('')}
                </div>
            </div>`;
    }).join('');
}

function orderBlock(o) {
    return `
        <div class="aorder" data-order="${escapeHtml(o.id)}">
            <div class="aorder-head" data-toggle>
                <span>#${escapeHtml(o.id)}</span>
                <span>${new Date(o.createdAt).toLocaleString()}</span>
                <span class="status-badge status-${escapeHtml(o.status)}">${escapeHtml(o.status)}</span>
                <span class="text-right text-accent">${peso(o.total)}</span>
                <span class="caret">►</span>
            </div>
            <div class="aorder-body">
                ${o.items.map(i => `<div class="aorder-line"><span>${escapeHtml(i.title)} <span class="text-[#666] font-mono">×${i.quantity} @ ${peso(i.unitPrice)} · cost ${peso(i.unitCost)}</span></span><span>${peso(i.lineTotal)}</span></div>`).join('')}
                <div class="aorder-actions">
                    <span class="admin-note mr-auto">${o.itemCount} item(s) · updated ${new Date(o.updatedAt).toLocaleString()}</span>
                    <select class="search-input" data-status-select>${STATUSES.map(s => `<option value="${s}"${s === o.status ? ' selected' : ''}>${s.toUpperCase()}</option>`).join('')}</select>
                    <button class="btn btn-blue" data-status-save>Update Status</button>
                </div>
            </div>
        </div>`;
}

async function onOrdersClick(e) {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
        playSound();
        toggle.parentElement.classList.toggle('is-open');
        return;
    }
    const save = e.target.closest('[data-status-save]');
    if (!save) return;
    const block = save.closest('[data-order]');
    const id = block.dataset.order;
    const status = block.querySelector('[data-status-select]').value;
    const order = adminOrders.find(o => String(o.id) === id);
    if (!order || order.status === status) { toast('Status unchanged'); return; }
    if (status === 'cancelled' && !window.confirm(`Cancel order #${id}? It will be excluded from sales.`)) return;

    save.disabled = true;
    const { ok, data } = await api(`/api/admin/orders/${id}/status`, { method: 'PATCH', body: { status } });
    save.disabled = false;
    if (!ok) { playSound('error'); toast('Status update failed', 'error'); return; }
    order.status = data.order.status;
    order.updatedAt = data.order.updatedAt;
    const openOrders = [...document.querySelectorAll('#admOrderList .aorder.is-open')].map(el => el.dataset.order);
    const openCustomers = new Set([...document.querySelectorAll('#admOrderList .cust-card.is-open .cust-mail')].map(el => el.textContent));
    renderOrders();
    // Re-open what was open so the owner doesn't lose their place.
    document.querySelectorAll('#admOrderList .cust-card').forEach(card => {
        if (openCustomers.has(card.querySelector('.cust-mail')?.textContent)) card.classList.add('is-open');
    });
    for (const oid of openOrders) {
        document.querySelector(`#admOrderList .aorder[data-order="${CSS.escape(oid)}"]`)?.classList.add('is-open');
    }
    playSound('success');
    toast(`Order #${id} → ${status.toUpperCase()}`);
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
            <tbody>${data.deleted.map(d => `<tr><td>#${escapeHtml(d.archiveId)}</td><td>${escapeHtml(d.title)} <span class="text-[#666] font-mono">(item ${d.productId}${d.hasImage ? ' · photo kept' : ''})</span></td><td class="num accent">${peso(d.price)}</td><td>${escapeHtml(d.reason || '—')}</td><td>${fmtDate(d.deletedAt)}<br><span class="text-[#666] font-mono text-[9px]">${escapeHtml(d.deletedBy || '')}</span></td></tr>`).join('')}</tbody>
        </table>` : '<div class="admin-empty">--- [ NO DELETED ITEMS ] ---</div>';
}
