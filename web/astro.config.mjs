import node from "@astrojs/node";
import preact from "@astrojs/preact";
import { defineConfig } from "astro/config";

// Server-rendered per #25/#27 (direct DB access, list rendered at request
// time) — no static output, no client fetch-on-mount for the initial list.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [preact()],
  // TLS terminates at the Cloudflare Tunnel; the connection to this server
  // is plain HTTP, so Astro's own origin comes out "http://..." while the
  // browser's Origin header is "https://...". @astrojs/node's standalone
  // server doesn't trust X-Forwarded-Proto to correct for that, so the
  // default origin-check CSRF guard rejects every form-accept action (e.g.
  // receipt.parse) with "Cross-site POST form submissions are forbidden".
  // The tunnel is the household's only entry point, so disabling this is a
  // deliberate trade rather than an oversight.
  security: { checkOrigin: false },
});
