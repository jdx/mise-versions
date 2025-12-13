import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";

// Plugin to serve /data/* from ../docs/* during development
function serveDocsPlugin() {
  return {
    name: "serve-docs",
    configureServer(server: { middlewares: { use: (handler: (req: { url?: string }, res: { statusCode: number; setHeader: (name: string, value: string) => void; end: (data?: string) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/data/")) {
          const filePath = resolve(__dirname, "..", "docs", req.url.slice(6));
          if (existsSync(filePath)) {
            const content = readFileSync(filePath, "utf-8");
            const ext = filePath.split(".").pop();
            const contentType =
              ext === "json"
                ? "application/json"
                : ext === "toml"
                  ? "text/plain"
                  : "text/plain";
            res.setHeader("Content-Type", contentType);
            res.end(content);
            return;
          }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [preact(), serveDocsPlugin()],
  build: {
    outDir: "dist",
  },
});
