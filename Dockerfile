# ═══════════════════════════════════════════════════════════════════
# GhostChat :: Dockerfile
# Builds the Flask + Flask-SocketIO (eventlet) backend, serving the
# frontend/ static files from the same container.
#
# IMPORTANT — single worker only:
# This app's Socket.IO rooms are tracked in each process's own memory
# (no Redis message queue configured for Socket.IO — that's a separate,
# optional thing from the rate-limiter's Redis). Running more than one
# worker/replica means users connected to different workers won't see
# each other's real-time messages reliably. Keep --workers 1 and keep
# replica count at 1 unless Socket.IO is reconfigured with a Redis
# message queue (a separate, future change).
# ═══════════════════════════════════════════════════════════════════

FROM python:3.11-slim

# eventlet/greenlet and psycopg2-binary occasionally need build tools
# for source-only wheels on certain platforms — keeping this small but
# present avoids an opaque pip failure during build.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (separate layer) so a code-only change
# doesn't force a full reinstall of every package on every deploy.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the repo — backend/ and frontend/ as siblings,
# matching the layout flask_app.py expects.
COPY . .

# Northflank (and most container platforms) inject PORT at runtime;
# 5000 is just the documented local-dev default.
ENV PORT=5000
EXPOSE 5000

# -k eventlet is required to match async_mode='eventlet' in flask_app.py.
# -w 1 is required — see the single-worker note above.
# --timeout 120 gives long-lived Socket.IO connections room to breathe
# past gunicorn's default 30s worker timeout.
# NOTE: target is "flask_app:app", not "backend.flask_app:app" — your
# wsgi.py/run.py both do a bare `from flask_app import app`, which only
# works if flask_app.py sits at the repo root (a sibling of backend/ and
# frontend/, not nested inside backend/). This matches that.
CMD gunicorn --worker-class eventlet --workers 1 --timeout 120 \
    --bind 0.0.0.0:${PORT} flask_app:app