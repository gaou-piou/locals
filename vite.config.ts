import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  root: "src",
  base: "./",
  publicDir: false,
  plugins: [tailwindcss(), svelte({ configFile: fileURLToPath(new URL("./svelte.config.js", import.meta.url)) }), svelteTesting()],
  resolve: { alias: { $lib: `${src}/lib` } },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: `${src}/popup/index.html`,
        options: `${src}/options/index.html`,
        background: `${src}/background/index.ts`,
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js"),
        // keep the service worker free of shared UI chunks
        manualChunks: undefined,
      },
    },
  },
  test: { root: ".", include: ["tests/**/*.test.ts"], environment: "node" },
});
