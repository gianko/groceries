// Telegram delivers initData via the URL fragment on launch, which never
// reaches the server — so the very first request can't be validated
// server-side. This page runs client-side only, reads
// `Telegram.WebApp.initData` (available once telegram-web-app.js has run),
// stashes it in a cookie, and reloads once so the *next* request is the one
// the middleware actually authenticates.
export function bootstrapHtml(): string {
  return `<!doctype html>
<html>
<head><script src="https://telegram.org/js/telegram-web-app.js"></script></head>
<body>
<script>
(function () {
  var initData = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData;
  if (initData) {
    document.cookie = "tg_init_data=" + encodeURIComponent(initData) + "; path=/; max-age=86400; samesite=none; secure";
    location.reload();
  }
})();
</script>
</body>
</html>`;
}
