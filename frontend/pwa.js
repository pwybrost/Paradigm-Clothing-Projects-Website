// Registers the service worker (offline copies of the shop) once the page has finished loading,
// so it never competes with the first paint. Turn it off by deleting this file's <script> tags.
(function () {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', function () {
        var register = function () { navigator.serviceWorker.register('/sw.js').catch(function () { /* unsupported / private mode */ }); };
        ('requestIdleCallback' in window) ? requestIdleCallback(register, { timeout: 4000 }) : setTimeout(register, 2000);
    });
})();
