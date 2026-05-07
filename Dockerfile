# Shifty — Cloud Run 用コンテナ
FROM python:3.10-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=8080
ENV PYTHONUNBUFFERED=True
ENV STORAGE_BACKEND=firestore

# Cloud Run 推奨設定: 1 worker, 8 threads, 60秒タイムアウト
CMD exec gunicorn server:app \
  --bind :$PORT \
  --workers 1 \
  --threads 8 \
  --timeout 60 \
  --graceful-timeout 30 \
  --access-logfile - \
  --error-logfile - \
  --capture-output \
  --log-level info
