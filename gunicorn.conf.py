"""Gunicorn settings for production (see render.yaml)."""
import os

bind = f"0.0.0.0:{os.environ.get('PORT', '10000')}"

# Threads, not processes: the in-memory YouTube search cache is per process,
# and a free instance has about 512 MB, which PyMuPDF can fill on its own.
workers = int(os.environ.get("WEB_CONCURRENCY", "1"))
threads = int(os.environ.get("GUNICORN_THREADS", "8"))
worker_class = "gthread"

# A 300-page PDF takes a while to rasterise on a small instance.
timeout = 120
graceful_timeout = 30
keepalive = 5

# No client address in the access log. The app's own logs are scrubbed by
# logging_filters.py; this keeps Gunicorn's from undoing that.
accesslog = "-"
access_log_format = '%(t)s "%(r)s" %(s)s %(b)s %(M)sms'
errorlog = "-"
