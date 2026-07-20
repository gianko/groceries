import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // "astro:actions" is a virtual module Astro's Vite plugin resolves at
      // build time; outside that plugin (i.e. under vitest) it doesn't
      // exist. defineAction itself has no virtual-module dependencies, so
      // pointing straight at astro's own server runtime lets action tests
      // exercise the real input-validation/handler-binding behaviour
      // without needing an Astro dev server.
      "astro:actions": fileURLToPath(
        new URL("./node_modules/astro/dist/actions/runtime/server.js", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
