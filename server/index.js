import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import compression from "compression";
import { createAgentApiMiddleware } from "./agentApi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT, "dist");

// In the container/monorepo the Python backend lives in ./backend.
// Locally you can point this at ../PSCAD via the PSCAD_DIR env var.
const PSCAD_DIR = process.env.PSCAD_DIR
  ? path.resolve(process.env.PSCAD_DIR)
  : path.join(ROOT, "backend");

const PORT = Number(process.env.PORT) || 8080;

const app = express();
app.use(compression());

// /api/* routes run the Python agent scripts; everything else falls through.
app.use(createAgentApiMiddleware({ pscadDir: PSCAD_DIR, pythonBin: process.env.PYTHON_BIN }));

app.use(express.static(DIST_DIR, { index: false }));

// SPA fallback: serve index.html for any non-API GET that isn't a static file.
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(DIST_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`[veragrid] server listening on http://0.0.0.0:${PORT}`);
  console.log(`[veragrid] serving static files from ${DIST_DIR}`);
  console.log(`[veragrid] python backend dir: ${PSCAD_DIR}`);
});
