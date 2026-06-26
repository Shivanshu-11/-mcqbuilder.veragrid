# Running & Deploying the VeraGrid MCQ Builder

This app has two parts that must run together:

- **Frontend** — React + Vite (the UI).
- **Backend** — Python agent scripts in [`backend/`](./backend) (OPF solve, MCQ
  generation, model evaluation, prompt building). These run via `VeraGridEngine`.

The `/api/*` routes are shared between dev and production via
[`server/agentApi.js`](./server/agentApi.js).

---

## 1. Run locally (development)

The Vite dev server runs the Python backend from the sibling `../PSCAD` folder
using its `.venv312` virtualenv.

```bash
npm install
npm run dev
```

Open http://localhost:5173/ — the full app works (OPF, MCQ, evaluation).

To point the dev server at a different Python backend folder:

```bash
PSCAD_DIR=/absolute/path/to/PSCAD npm run dev
```

## 2. Run the production server locally

This builds the static frontend and serves it together with the API from a
single Node process ([`server/index.js`](./server/index.js)).

```bash
# Build the frontend for a root-domain ("/") deployment
npm run build:fullstack

# Serve dist/ + /api/* on http://localhost:8080
# PSCAD_DIR defaults to ./backend; PYTHON_BIN lets you reuse an existing venv.
PYTHON_BIN=../PSCAD/.venv312/bin/python3 npm start
```

---

## 3. Publish for anyone (Docker — recommended)

The [`Dockerfile`](./Dockerfile) bundles Node + Python 3 + `VeraGridEngine` and
the vendored backend in [`backend/`](./backend). It builds the frontend with
base path `/` and serves everything on `$PORT` (default 8080).

### Build & run locally with Docker

```bash
docker build -t veragrid-mcq .
docker run --rm -p 8080:8080 veragrid-mcq
# open http://localhost:8080/
```

### Deploy to Render (Git-based, simplest)

1. Push this repo (including the `backend/` folder) to GitHub.
2. On https://render.com → **New** → **Web Service** → connect the repo.
3. Render auto-detects [`render.yaml`](./render.yaml) (Docker runtime). Otherwise
   choose **Docker** manually.
4. First deploy compiles the scientific Python stack, so it takes several
   minutes. Subsequent deploys are cached.
5. **Memory:** the `starter` (512 MB) plan can be tight for OPF/MCQ solves. If
   you see out-of-memory crashes, bump the plan to `standard` (2 GB) in
   `render.yaml` or the dashboard.

The same `Dockerfile` works on **Railway** (New Project → Deploy from repo →
Dockerfile) and **Fly.io** (`fly launch` → `fly deploy`).

---

## API keys

Users paste their own Anthropic / OpenAI / Cursor API keys into the UI; the
server forwards them to the Python scripts per request. **No secret keys are
baked into the image**, so it is safe to publish.

> Note: the backend writes scratch files (e.g. `web_model_input.json`,
> `opf_results.web.json`) inside `backend/`. These are shared across requests,
> so the current setup is best for light/single-user traffic. For heavy
> concurrent use, give each request its own working directory.

---

## Keeping `backend/` in sync with `../PSCAD`

The Python scripts in [`backend/`](./backend) are vendored copies of the files
in `../PSCAD`. If you change the originals, re-copy them:

```bash
cp ../PSCAD/{web_opf_agent,opf_mcq_generator_150,opf_mcq_adversarial,evaluator,prompt_builder,agent,tools}.py backend/
```

---

## GitHub Pages (frontend only)

The existing [`.github/workflows/deploy-pages.yml`](./.github/workflows/deploy-pages.yml)
still deploys a **static, frontend-only** build to GitHub Pages. That site loads
the UI but the OPF/MCQ/evaluation buttons will fail there because GitHub Pages
cannot run the Python backend. Use the Docker deployment above for full
functionality.
