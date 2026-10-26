"""`python -m cerea_documents`: run the service with uvicorn."""

from __future__ import annotations

import logging
import os
import sys

import uvicorn

from .api import create_app
from .config import Settings
from .errors import ConfigError


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("CEREA_DOCUMENTS_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        app = create_app(Settings.from_env())
    except ConfigError as exc:
        print(f"cerea-documents: {exc}", file=sys.stderr)
        return 2
    uvicorn.run(
        app,
        host=os.environ.get("CEREA_DOCUMENTS_HOST", "0.0.0.0"),  # noqa: S104 - inside a container, on an internal network
        port=int(os.environ.get("CEREA_DOCUMENTS_PORT", "8090")),
        log_level="warning",
        access_log=False,
        server_header=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
