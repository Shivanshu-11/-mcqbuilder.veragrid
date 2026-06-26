# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: build the React/Vite frontend with a root base path ("/").
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
RUN PUBLIC_BASE=/ npm run build

# ---------------------------------------------------------------------------
# Stage 2: runtime image with Node (server) + Python (agent scripts).
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PYTHON_BIN=/opt/venv/bin/python3 \
    PSCAD_DIR=/app/backend \
    PORT=8080 \
    MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/matplotlib \
    XDG_CACHE_HOME=/tmp/cache

WORKDIR /app

# System deps: python + libs needed by VeraGridEngine's transitive deps
# (opencv needs libGL/libglib; build-essential covers any sdist builds).
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-venv python3-dev build-essential \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies in an isolated virtualenv.
COPY backend/requirements.txt ./backend/requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r backend/requirements.txt

# Node production dependencies only (express, compression).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application code + built frontend.
COPY server ./server
COPY backend ./backend
COPY --from=frontend /app/dist ./dist

EXPOSE 8080
CMD ["node", "server/index.js"]
