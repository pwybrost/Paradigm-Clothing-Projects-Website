// Vercel Web Analytics (privacy-friendly page views, no cookies).
// Only loads on the deployed site. Turn it on once in Vercel: Project -> Analytics -> Enable.
(function () {
    if (!/\.vercel\.app$/.test(location.hostname)) return;
    window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
    const s = document.createElement('script');
    s.defer = true;
    s.src = '/_vercel/insights/script.js';
    document.head.appendChild(s);
})();
