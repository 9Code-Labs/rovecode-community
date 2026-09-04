import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Static site: `bun run build` → dist/, served from the domain root by any file server (see README.md).
 *  Asset URLs are root-absolute (/assets, /brand, /shots); set `base` if it ever moves under a sub-path. */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: { port: 5173, strictPort: true },
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      output: {
        // long-lived vendor chunks apart from the page, so a copy change does not re-download React
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\/]node_modules[\/](react|react-dom|scheduler)[\/]/.test(id)) return "react";
          if (/[\/]node_modules[\/]motion/.test(id)) return "motion";
          if (/[\/]node_modules[\/](radix-ui|@radix-ui|lucide-react|class-variance-authority|clsx|tailwind-merge)[\/]/.test(id)) return "ui";
          return undefined;
        },
      },
    },
  },
});
