FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

WORKDIR /app

COPY requirements-runtime.txt .
RUN pip install -r requirements-runtime.txt \
    && playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Semantic embeddings are optional to the application workflow. Enable this
# target when running the standalone embedding pipeline in the API container.
ARG INSTALL_EMBEDDINGS=false
RUN if [ "$INSTALL_EMBEDDINGS" = "true" ]; then \
      pip install torch --index-url https://download.pytorch.org/whl/cpu \
      && pip install 'sentence-transformers>=3.0.0,<6'; \
    fi

COPY alembic.ini .
COPY migrations ./migrations
COPY src ./src
RUN useradd --create-home --uid 10001 hireflow \
    && mkdir -p /app/data \
    && chown -R hireflow:hireflow /app/data
USER hireflow

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.getenv('PORT','8000')+'/health', timeout=4)"

# Migrations must succeed before the API starts accepting requests. PORT is
# honored by hosted platforms and defaults to the local API port.
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn src.api.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
