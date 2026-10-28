# syntax=docker/dockerfile:1
# cerea-documents: the Office document service (ADR 0103). No LibreOffice, no browser.
# Alpine keeps the image under the 300 MB gate with matplotlib and numpy (charts) inside it.
# Build from this directory:  docker build -t cerea-documents documents/

FROM python:3.13-alpine AS build
COPY --from=ghcr.io/astral-sh/uv:0.8.4 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /src
# dependencies first, so source edits do not invalidate the layer
COPY pyproject.toml uv.lock .python-version README.md ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
COPY dedupe_libs.py ./
RUN apk add --no-cache binutils \
 && uv sync --frozen --no-dev --no-editable \
 && cd /src/.venv/lib/python3.13/site-packages \
 && find . \( -name '*.pyi' -o -name '*.c' -o -name '*.h' -o -name '*.pyx' -o -name '*.pxd' \) -delete \
 && find . -type d \( -name tests -o -name test \) -prune -exec rm -rf {} + \
 && rm -rf matplotlib/mpl-data/sample_data matplotlib/mpl-data/images matplotlib/mpl-data/fonts/afm matplotlib/mpl-data/fonts/pdfcorefonts numpy/f2py \
 && find . -name '*.so*' -type f -exec strip --strip-unneeded {} + \
 && python /src/dedupe_libs.py . \
 && MPLCONFIGDIR=/tmp python -c "import matplotlib.pyplot, contourpy, kiwisolver, numpy, PIL, lxml, reportlab, docx, pptx, openpyxl, pypdf, jsonschema, uvicorn, starlette, pypdfium2 as p; d = p.PdfDocument.new(); d.new_page(100, 100); assert d[0].render(scale=1).to_pil().size == (100, 100)"

FROM python:3.13-alpine
ARG VERSION=0.1.0
LABEL org.opencontainers.image.title="cerea-documents" \
      org.opencontainers.image.description="Cerea document service: typed, hardened Office edits" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"
RUN addgroup -S -g 10001 docs && adduser -S -u 10001 -G docs -H -s /sbin/nologin docs
COPY --from=build /src/.venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    CEREA_DOCUMENTS_HOST=0.0.0.0 \
    CEREA_DOCUMENTS_PORT=8090 \
    CEREA_DOCUMENTS_TMPDIR=/tmp
USER 10001:10001
WORKDIR /tmp
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import os,sys,urllib.request as u; sys.exit(0 if u.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('CEREA_DOCUMENTS_PORT','8090'), timeout=2).status == 200 else 1)"]
CMD ["python", "-m", "cerea_documents"]
