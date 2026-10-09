import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/postcss";
import prefixSelector from "postcss-prefix-selector";
export default defineConfig({
  root: "web",
  plugins: [react()],
  css: { postcss: { plugins: [tailwind(), prefixSelector({ prefix: ":where(.aui-vendor)", includeFiles: [/official-selector\.css/], transform(prefix, selector) { return selector === ":root" || selector === ":host" || selector.includes(".aui-vendor") ? selector : `${prefix} ${selector}`; } })] } },
  build: { assetsInlineLimit: 0, outDir: "../public", emptyOutDir: true },
  server: { host: "127.0.0.1", proxy: { "/api": "http://127.0.0.1:8080" } },
});
