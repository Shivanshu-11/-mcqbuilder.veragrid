import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { createAgentApiMiddleware } from "./server/agentApi.js";

// PSCAD (Python backend) location. Defaults to the sibling ../PSCAD folder for
// local development; override with PSCAD_DIR (e.g. ./backend in the container).
const PSCAD_DIR = process.env.PSCAD_DIR
  ? path.resolve(process.env.PSCAD_DIR)
  : path.resolve(process.cwd(), "../PSCAD");

function createAgentApiPlugin() {
  const handler = createAgentApiMiddleware({ pscadDir: PSCAD_DIR });
  return {
    name: "veragrid-agent-api",
    configureServer(server) {
      server.middlewares.use(handler);
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
