FROM python:3.14-alpine@sha256:47f36929d95852c8aa959380eeeea761ba7411ebe793d090da4cd518ac3af237

LABEL org.opencontainers.image.source="https://github.com/whirmill/umbrel-community-app-store"
LABEL org.opencontainers.image.description="Cloudflare multi-zone DDNS service for Umbrel"

COPY --chown=1000:1000 app/cloudflare_ddns.py /app/cloudflare_ddns.py
COPY --chown=1000:1000 web/ /web/

ENV DATA_DIR=/data \
    WEB_DIR=/web \
    HOST=0.0.0.0 \
    PORT=8080 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

USER 1000:1000
EXPOSE 8080

CMD ["python", "/app/cloudflare_ddns.py"]
