import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Separate Vite entry for the dashboard SPA. Builds to `dist-dashboard/`,
// embedded into the Rust binary via `rust-embed` in release builds.
//
// The dashboard bundle MUST NOT import from `@tauri-apps/api`, `src/components/`,
// or `src/stores/` — it runs in Chrome, not in the Tauri webview, and has no
// IPC bridge. Use `src/shared/` for cross-bundle constants. The boundary is
// currently enforced by code review (Phase 2 will add ESLint
// `no-restricted-imports` per v3 §3.17 / v4 §3.14).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  root: resolve(__dirname, "src/dashboard"),
  build: {
    outDir: resolve(__dirname, "dist-dashboard"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "src/dashboard/index.html"),
    },
  },
});
