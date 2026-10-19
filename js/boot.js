/* Runs before the app: theme (no flash), platform hints, global error capture. Kept tiny and dependency-free. */
(function () {
  var d = document.documentElement;
  try { var t = JSON.parse(localStorage.getItem('stardust.theme')); if (t === 'light' || t === 'dark') d.dataset.theme = t; } catch (e) { /* storage unavailable */ }
  var ua = navigator.userAgent;
  d.dataset.os = /Linux/.test(ua) && !/Android/.test(ua) ? 'linux' : /Windows/.test(ua) ? 'windows' : /Mac/.test(ua) ? 'mac' : 'other';
  if (window.stardustHost) d.dataset.host = 'app';
  var shown = 0;
  function report(msg) {
    if (shown++ > 3) return;
    try { console.error('[stardust]', msg); var n = document.getElementById('toasts') || document.body; var t = document.createElement('div'); t.className = 'toast in'; t.setAttribute('role', 'alert'); t.textContent = 'Something went wrong — your projects are safe. ' + String(msg).slice(0, 90); n.appendChild(t); setTimeout(function () { t.remove(); }, 6000); } catch (e) { /* ignore */ }
  }
  addEventListener('error', function (e) { if (e.message && !/ResizeObserver/.test(e.message)) report(e.message); });
  addEventListener('unhandledrejection', function (e) { report(e.reason && e.reason.message || e.reason || 'Unexpected error'); });
  // Offline support for the browser build (the desktop app serves from its own bundled server).
  if ('serviceWorker' in navigator && document.querySelector('meta[name=stardust-offline]') && /^https?:$/.test(location.protocol) && !window.stardustHost && !/^(localhost|127.0.0.1)$/.test(location.hostname)) addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { /* optional */ }); });
})();
