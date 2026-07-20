// Telegram delivers initData via the URL fragment on launch, which never
// reaches the server — so the very first request can't be validated
// server-side. This page runs client-side only, reads
// `Telegram.WebApp.initData` (available once telegram-web-app.js has run),
// stashes it in a cookie, and navigates once so the *next* request is the
// one the middleware actually authenticates.
//
// That navigation also has to resolve the `startapp` deep link: a group
// chat's "Open in app" button (see src/bot.ts's webAppDeepLink) can only
// launch the Mini App at its one registered URL, carrying the intended
// screen as `start_param` rather than as a path — so the first load after
// a fresh cookie is also where that param gets turned into a path.
export function bootstrapHtml(): string {
  return `<!doctype html>
<html>
<head><script src="https://telegram.org/js/telegram-web-app.js"></script></head>
<body>
<script>
(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  var initData = tg && tg.initData;
  if (initData) {
    document.cookie = "tg_init_data=" + encodeURIComponent(initData) + "; path=/; max-age=86400; samesite=none; secure";
    var startParam = tg.initDataUnsafe && tg.initDataUnsafe.start_param;
    var routes = { cook: "/cook", shopping: "/shopping", staples: "/staples" };
    location.replace((startParam && routes[startParam]) || location.pathname);
  }
})();
</script>
</body>
</html>`;
}
