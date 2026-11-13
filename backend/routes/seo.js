// Shareable product pages and a live sitemap.
//   /p/:id        small HTML page with the product's own preview (Facebook/Messenger/Google) that
//                 forwards visitors to the archive with that item open.
//   /sitemap.xml  lists the store pages and every visible product.
import { Router } from 'express';
import { baseUrl } from '../config.js';
import { listProducts } from '../lib/catalog.js';
import { parsePositiveInt } from '../lib/validation.js';

const router = Router();
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

router.get('/p/:id', async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    const [p] = id ? await listProducts({ id }) : [];
    if (!p) return res.redirect(302, '/index.html');
    const base = baseUrl(req);
    const target = `/index.html?item=${p.id}`;
    const image = p.image ? `${base}${p.image}` : `${base}/favicon.svg`;
    const inStock = p.variants.some((v) => v.stock > 0);
    const desc = `${p.desc} · ₱${p.price.toLocaleString()}`.slice(0, 200);
    // schema.org Product data so Google can show price and availability.
    const jsonLd = {
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: p.title,
        description: p.desc,
        image: [image],
        sku: `PRDGM-${p.id}`,
        brand: { '@type': 'Brand', name: 'Paradigm Clothing Projects' },
        category: p.category,
        offers: {
            '@type': 'Offer',
            url: `${base}/p/${p.id}`,
            priceCurrency: 'PHP',
            price: p.price.toFixed(2),
            availability: inStock ? 'https://schema.org/InStock' : (p.allowPreorder ? 'https://schema.org/PreOrder' : 'https://schema.org/OutOfStock'),
        },
        ...(p.reviewCount ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: p.rating, reviewCount: p.reviewCount } } : {}),
    };
    res.set('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=600');
    res.type('html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${esc(p.title)} | Paradigm</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(`${base}/p/${p.id}`)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="product">
<meta property="og:site_name" content="Paradigm Clothing Projects">
<meta property="og:title" content="${esc(p.title)} · ₱${p.price.toLocaleString()}">
<meta property="og:description" content="${esc(p.desc)}">
<meta property="og:url" content="${esc(`${base}/p/${p.id}`)}">
<meta property="og:image" content="${esc(image)}">
<meta property="product:price:amount" content="${p.price.toFixed(2)}">
<meta property="product:price:currency" content="PHP">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
<meta http-equiv="refresh" content="0; url=${esc(target)}">
<script>location.replace(${JSON.stringify(target)});</script>
</head><body style="background:#000;color:#fff;font-family:monospace;text-align:center;padding:80px 20px">
<p>Opening <a style="color:#3b82f6" href="${esc(target)}">${esc(p.title)}</a>...</p></body></html>`);
});

router.get('/sitemap.xml', async (req, res) => {
    const base = baseUrl(req);
    const products = await listProducts();
    const url = (loc, priority, lastmod) => `<url><loc>${esc(loc)}</loc>${lastmod ? `<lastmod>${new Date(lastmod).toISOString().slice(0, 10)}</lastmod>` : ''}<priority>${priority}</priority></url>`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${url(`${base}/`, '1.0')}
${url(`${base}/Info.html`, '0.6')}
${products.map((p) => url(`${base}/p/${p.id}`, '0.8', p.createdAt)).join('\n')}
</urlset>`;
    res.set('Cache-Control', 'public, max-age=0, s-maxage=3600').type('application/xml').send(xml);
});

export default router;
