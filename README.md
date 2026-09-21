# VeraGrid MCQ Builder

A web app for building and evaluating AC optimal power flow (AC-OPF) multiple-choice
questions. It has three pages:

- **Circuit** — define a power-system circuit and solve the OPF.
- **MCQ** — generate multiple-choice questions from the solved circuit.
- **Model** — build prompts and evaluate LLMs against the generated questions.

The UI is React + Vite; the solving and question generation run in Python
([`backend/`](./backend)) via `VeraGridEngine`, behind the `/api/*` routes in
[`server/agentApi.js`](./server/agentApi.js).

- **Live demo (UI only):** https://shivanshu-11.github.io/-mcqbuilder.veragrid/ —
  GitHub Pages cannot run Python, so the OPF/MCQ/evaluation buttons fail there.
  Run it locally (below) for the working app.

---

## Run on your own computer

Prerequisites: **Node 22+**, **Python 3.12+**, and `git`.

```bash
git clone https://github.com/Shivanshu-11/-mcqbuilder.veragrid.git
cd -mcqbuilder.veragrid
```

### 1. Install the Python backend

The backend needs its own virtualenv at `backend/.venv312`, which the server
discovers automatically:

```bash
python3 -m venv backend/.venv312
backend/.venv312/bin/pip install -r backend/requirements.txt
```

This compiles the scientific Python stack (numpy/scipy/pandas/numba/highspy), so
the first install takes a few minutes.

### 2. Install and start the frontend

```bash
npm install
npm run dev
```

Open http://localhost:5173/. The dev server prints which Python backend folder it
is using; on a fresh clone that is the in-repo `backend/`. To point it elsewhere:

```bash
PSCAD_DIR=/absolute/path/to/backend npm run dev
```

### 3. Optional: run the production build locally

Serves the static build and the API from one Node process on port 8080:

```bash
npm run build:fullstack
npm start
# open http://localhost:8080/
```

### Optional: Docker instead of a local toolchain

```bash
docker build -t veragrid-mcq .
docker run --rm -p 8080:8080 veragrid-mcq
# open http://localhost:8080/
```

## API keys

You paste your own Anthropic / OpenAI / Cursor API keys into the UI, and the
server forwards them to the Python scripts per request. No keys are stored in
the repo or baked into the Docker image.

## More

- [`DEPLOY.md`](./DEPLOY.md) — hosting the full app (Render, Railway, Fly.io) and
  keeping `backend/` in sync with its upstream source.
- `npm run lint` — ESLint over the frontend.
