FROM python:3.11-slim

WORKDIR /app

# Env
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

# System deps
RUN apt-get update && apt-get install -y gcc && rm -rf /var/lib/apt/lists/*

# Install Python deps — requirements.txt lives inside backend/
COPY backend/requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy entire project
COPY . .

# Run gunicorn from inside backend/ so local imports work correctly
# (crypto/, obfuscation/, ai/, utils/ are siblings of flask_app.py)
CMD cd backend && gunicorn flask_app:app \
    --bind 0.0.0.0:${PORT:-5000} \
    --workers 2 \
    --timeout 120 \
    --access-logfile - \
    --error-logfile -