import node from "@astrojs/node";
import preact from "@astrojs/preact";
import { defineConfig } from "astro/config";

// Server-rendered per #25/#27 (direct DB access, list rendered at request
// time) — no static output, no client fetch-on-mount for the initial list.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [preact()],
});
