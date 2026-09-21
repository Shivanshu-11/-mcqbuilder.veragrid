import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentApiMiddleware } from "./server/agentApi.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Python backend location, in priority order:
// - PSCAD_DIR: explicit override.
// - ../PSCAD: the upstream working copy, when developing next to it.
// - ./backend: the vendored copy that ships with this repo (fresh clones).
function resolvePscadDir() {
  if (process.env.PSCAD_DIR) {
    return path.resolve(process.env.PSCAD_DIR);
  }
  const sibling = path.resolve(ROOT, "../PSCAD");
  if (fs.existsSync(sibling)) {
    return sibling;
  }
  return path.join(ROOT, "backend");
}

const PSCAD_DIR = resolvePscadDir();

function createAgentApiPlugin() {
  const handler = createAgentApiMiddleware({ pscadDir: PSCAD_DIR });
  return {
    name: "veragrid-agent-api",
    configureServer(server) {
      server.middlewares.use(handler);
      server.config.logger.info(`[veragrid] python backend dir: ${PSCAD_DIR}`);
    },
  };
}

// Base public path for the built site.
// - PUBLIC_BASE (e.g. "/"): explicit override for full-stack hosting at a root domain.
// - GITHUB_REPOSITORY ("owner/repo"): GitHub Pages project URL -> "/<repo>/".
// - Fallback: the GitHub repo name for local `npm run build`.
function productionBase() {
  if (process.env.PUBLIC_BASE) {
    return process.env.PUBLIC_BASE;
  }
  if (process.env.GITHUB_REPOSITORY) {
    const repo = process.env.GITHUB_REPOSITORY.split("/")[1];
    return `/${repo}/`;
  }
  return "/-mcqbuilder.veragrid/";
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), createAgentApiPlugin()],
  base: mode === "development" ? "/" : productionBase(),
}));
