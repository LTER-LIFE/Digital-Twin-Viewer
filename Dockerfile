# The bundled dataset ships in /app/seed, not /app/data: compose mounts a named
# volume over /app/data, and Docker only populates a named volume from the image
# when the volume is empty. Shipping it there would mean a redeploy never
# updates the dataset on a host that has run the app before. server.py copies
# seed/ -> data/ at startup instead. This throwaway stage does the split so the
# final image holds the data once; a COPY-then-mv in the final image would leave
# both copies in separate layers.
FROM python:3.12-slim AS layout
COPY . /src/
RUN set -eu; \
    mkdir -p /out/seed; \
    if [ -d /src/data ]; then cp -a /src/data/. /out/seed/; rm -rf /src/data; fi; \
    mv /src /out/app

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HOST=0.0.0.0 \
    PORT=8501

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN addgroup --system app && adduser --system --ingroup app app
COPY --from=layout --chown=app:app /out/app/ ./
COPY --from=layout --chown=app:app /out/seed/ ./seed/
# /app/data must exist and be app-owned before the volume mounts over it — a
# named volume inherits the mountpoint's ownership from the image
RUN mkdir -p /app/uploads /app/data && chown app:app /app/uploads /app/data

USER app

EXPOSE 8501

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.getenv('PORT', '8501') + '/api/datasets', timeout=5).read()" || exit 1

CMD ["python", "server.py", "--no-browser"]
