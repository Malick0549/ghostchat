FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

# System deps
RUN apt-get update && apt-get install -y gcc && rm -rf /var/lib/apt/lists/*

# Install Python deps
COPY backend/requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy entire project
COPY . .

# Work from inside backend/ so local imports resolve correctly
WORKDIR /app/backend

# SocketIO + eventlet requires the eventlet worker class
# flask_app.py exposes `app` at module level (line: app = create_app())
CMD gunicorn flask_app:app \
    --worker-class eventlet \
    --workers 1 \
    --bind 0.0.0.0:${PORT:-5000} \
    --timeout 120 \
    --access-logfile - \
    --error-logfile -