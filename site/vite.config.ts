import path from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Static site: `bun run build` → dist/, served from the domain root by any file server (see README.md).
 *  Asset URLs are root-absolute (/assets, /brand, /shots); set `base` if it ever moves under a sub-path. */
/** %VITE_SITE_URL% in index.html → the deploy environment's value, else .env, else the current server. Vite would
 *  leave the placeholder in place when the variable is missing (a CI build without .env did exactly that), so the
 *  substitution is done here with a fallback instead. */
function siteUrl(mode: string): Plugin {
  return {
    name: "site-url",
    transformIndexHtml(html) {
      const url = (process.env.VITE_SITE_URL || loadEnv(mode, __dirname).VITE_SITE_URL || "http://64.177.43.110").replace(/\/$/, "");
      return html.replaceAll("%VITE_SITE_URL%", url);
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), siteUrl(mode)],
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
          if (/[\/]node_modules[\/](radix-ui|@radix-ui|lucide-react|class-variance-authority|clsx|tailwind-merge)[\/]/.test(id)) return "ui";
          return undefined;
        },
      },
    },
  },
}));
