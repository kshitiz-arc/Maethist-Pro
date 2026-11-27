# MAETHIST as a container: the same app Render runs, with gunicorn.
#
#   docker run -p 8000:8000 -e SECRET_KEY=... ghcr.io/kshitiz-arc/maethist-pro:2.10.2
#
# then open http://localhost:8000. Behind an HTTPS proxy (Render, Fly, a load
# balancer), also pass -e FORCE_HTTPS=true -e TRUST_PROXY_HEADERS=true.
# Settings are the ones in .env.example. Keep it to one process: live boards
# are held in memory (see CLAUDE.md), so scale with GUNICORN_THREADS.
FROM python:3.12.7-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8000 \
    INKYSCIB_ENV=production \
    FORCE_HTTPS=false \
    WEB_CONCURRENCY=1 \
    VISITS_PATH=/data/visits.json

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Run as a user with no rights beyond the app and its one writable folder,
# /data, where the visit counter keeps its daily totals. Mount a volume there
# to keep them across restarts.
RUN useradd --create-home --uid 10001 maethist \
    && mkdir -p /data \
    && chown maethist:maethist /data
USER maethist
VOLUME ["/data"]

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT', '8000'), timeout=4)"

CMD ["gunicorn", "wsgi:app", "--config", "gunicorn.conf.py"]
