FROM python:3.11-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y gcc && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

COPY . .

# The app module lives in the repo root, so keep /app as the working directory
ENV PYTHONPATH=/app

# eventlet MUST use --workers 1 (it's concurrent within one process)
# Use shell form so $PORT expands correctly
CMD gunicorn flask_app:app \
    --worker-class eventlet \
    --workers 1 \
    --bind 0.0.0.0:${PORT:-8080} \
    --timeout 120 \
    --keep-alive 5 \
    --log-level info