# syntax=docker/dockerfile:1
# cerea-sandbox-python: the image `execute_code` runs in on the server (ADR 0115, class E): Python
# 3.13 with a pinned scientific and office stack, and the exec daemon (execd.py). Nothing here is
# installed at run time: a sandbox has no network.
# Build:  docker build -t cerea-sandbox-python sandbox/exec-image/
FROM python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90
ARG VERSION=0.1.0
LABEL org.opencontainers.image.title="cerea-sandbox-python" \
      org.opencontainers.image.description="Python sandbox image for Cerea execute_code" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --root-user-action=ignore --only-binary=:all: -r /tmp/requirements.txt \
 && rm /tmp/requirements.txt \
 && MPLCONFIGDIR=/tmp/mpl python -c "import numpy, pandas, matplotlib, scipy, PIL, openpyxl, docx, pptx, xlsxwriter, reportlab, pypdf, seaborn, lxml, sklearn, sympy"
COPY execd.py run.py /opt/execd/
# The paths the model is told (/mnt/data for attachments, /mnt/output for deliverables), pointing into
# the sandbox's one writable workspace: the root file system is read-only.
RUN mkdir -p /mnt /workspace && ln -s /workspace/data /mnt/data && ln -s /workspace/output /mnt/output
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MPLBACKEND=Agg
