import { Router } from 'express';
import { config } from '../../config';

export const handoffLandingRouter = Router();

/** Escape for safe HTML attribute / script string interpolation. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    (
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }) as Record<string, string>
    )[c] ?? c,
  );
}

/**
 * Minimal HTTPS landing for a delivery link. Renders a page that immediately
 * tries to open the app deep-link scheme; if the app isn't installed, users
 * can fall back to the Play Store (Android) or App Store (iOS).
 *
 * Kept intentionally small and dependency-free so it works from any
 * whitelisted origin without a full web framework.
 */
handoffLandingRouter.get('/d/:token', (req, res) => {
  const rawToken = String(req.params.token ?? '');
  const rawOrder = String((req.query.o as string | undefined) ?? '');
  const token = rawToken.trim();
  if (!token) {
    res.status(400).type('text/plain').send('Missing delivery token');
    return;
  }

  const appUrl = `${config.handoff.appScheme}?t=${encodeURIComponent(token)}${
    rawOrder ? `&o=${encodeURIComponent(rawOrder)}` : ''
  }`;
  const playUrl = 'https://play.google.com/store/apps/details?id=com.buddies.buddies_supplier';
  const appStoreUrl = 'https://apps.apple.com/app/buddies-supplier/id0';

  res
    .status(200)
    .type('text/html')
    .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Open Buddies delivery</title>
<meta name="robots" content="noindex,nofollow" />
<style>
  html,body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F5F7F5;color:#0F2617;}
  main{max-width:420px;margin:0 auto;padding:48px 24px 32px;text-align:center;}
  h1{font-size:22px;margin:0 0 8px;color:#1F5D3A;}
  p{font-size:15px;line-height:1.5;color:#3F5245;margin:0 0 24px;}
  .btn{display:block;width:100%;padding:14px 18px;margin:10px 0;border-radius:999px;text-decoration:none;font-weight:600;font-size:15px;box-sizing:border-box;}
  .btn.primary{background:#1F5D3A;color:#fff;}
  .btn.ghost{background:transparent;color:#1F5D3A;border:1px solid #C1D9CB;}
  .hint{font-size:12px;color:#6B7B70;margin-top:24px;}
</style>
</head>
<body>
<main>
  <h1>Open Buddies delivery</h1>
  <p>Tap the button below to open the delivery in the Buddies Supplier app.</p>
  <a class="btn primary" id="open" href="${esc(appUrl)}">Open in Buddies</a>
  <a class="btn ghost" id="play" href="${esc(playUrl)}">Get the app (Play Store)</a>
  <a class="btn ghost" id="ios" href="${esc(appStoreUrl)}" style="display:none">Get the app (App Store)</a>
  <p class="hint">If nothing happens, install Buddies Supplier and reopen this link.</p>
</main>
<script>
  (function(){
    var ua = navigator.userAgent || '';
    var isIOS = /iPad|iPhone|iPod/.test(ua);
    if (isIOS) {
      document.getElementById('play').style.display = 'none';
      document.getElementById('ios').style.display = '';
    }
    // Auto-attempt on load. iOS Safari needs a user gesture for custom schemes,
    // so we fall back to the store button if the scheme isn't handled.
    var app = ${JSON.stringify(appUrl)};
    var opened = false;
    var t = setTimeout(function(){
      if (!opened) {
        // Nothing else to do — user can tap Get the app.
      }
    }, 1500);
    window.addEventListener('blur', function(){ opened = true; clearTimeout(t); });
    try { window.location.href = app; } catch (e) {}
  })();
</script>
</body>
</html>`);
});
