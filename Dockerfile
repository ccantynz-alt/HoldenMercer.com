# ── STAGE 1: Build frontend ───────────────────────────────────────────────────
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --prefer-offline
COPY frontend/ ./
RUN npm run build

# ── STAGE 2: Sovereign Engine ─────────────────────────────────────────────────
FROM python:3.11-slim AS runtime
WORKDIR /app

# System deps: gcc for psycopg2, curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc \
        libpq-dev \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps first (layer-cached unless requirements change)
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy application packages
COPY core/       ./core/
COPY services/   ./services/
COPY api/        ./api/
COPY migrations/ ./migrations/

# Frontend build output — placed where api/main.py expects it
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Security: non-root user
RUN useradd -m -u 1001 sovereign
USER sovereign

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

CMD ["gunicorn", \
     "--workers", "4", \
     "--worker-class", "uvicorn.workers.UvicornWorker", \
     "--bind", "0.0.0.0:8000", \
     "--timeout", "120", \
     "--access-logfile", "-", \
     "--error-logfile", "-", \
     "api.main:app"]
