"""Run one request in a fresh, resource-limited subprocess. The HTTP process never parses a
document: it writes the bytes to a private directory, starts the worker, waits (killing it on
overrun) and reads back the result."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import signal
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import Limits
from .errors import DocumentError, ResourceLimit, TimeLimit
from .worker import EXIT_MEMORY

log = logging.getLogger("cerea_documents")
STATS: dict[str, int] = {"peak_rss_kb": 0}  # the largest memory any worker reported, for diagnostics and tests


@dataclass
class JobResult:
    result: dict[str, Any]
    file: bytes | None = None


def _env() -> dict[str, str]:
    """A minimal environment: the worker never sees the shared secret or any other setting."""
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "LANG": "C.UTF-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONHASHSEED": "random",
        # numpy (charts) reserves address space per thread; one thread keeps it inside the worker's memory cap
        "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
    }


def _error(payload: dict[str, Any]) -> DocumentError:
    from . import errors

    err = payload["error"]
    status = int(payload.get("status", 422))
    cls = {
        "invalid_request": errors.InvalidRequest,
        "operation_failed": errors.PatchError,
        "invalid_document": errors.InvalidDocument,
        "unsafe_document": errors.UnsafeDocument,
        "unsupported_format": errors.UnsupportedFormat,
        "resource_limit": errors.ResourceLimit,
    }.get(err.get("code", ""), DocumentError)
    exc = cls(
        err.get("message", "request failed"),
        reason=err.get("reason"),
        details=err.get("details"),
        operation_index=err.get("operation_index"),
    )
    exc.status = status
    if cls is DocumentError:
        exc.code = err.get("code", "internal_error")
    return exc


async def run_job(
    kind: str,
    doc: bytes,
    *,
    filename_format: str | None,
    body: dict[str, Any] | None,
    images: dict[str, bytes],
    limits: Limits,
    tmpdir: str | None = None,
) -> JobResult:
    with tempfile.TemporaryDirectory(prefix="cdoc-", dir=tmpdir) as d:
        job = Path(d)
        os.chmod(job, 0o700)
        names = list(images)
        (job / "images").mkdir()
        for i, name in enumerate(names):
            (job / "images" / str(i)).write_bytes(images[name])
        (job / "doc.bin").write_bytes(doc)
        (job / "job.json").write_text(
            json.dumps(
                {
                    "kind": kind,
                    "filename_format": filename_format,
                    "body": body,
                    "images": names,
                    "limits": limits.to_dict(),
                }
            ),
            encoding="utf-8",
        )
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-I",
            "-m",
            "cerea_documents.worker",
            str(job),
            env=_env(),
            cwd=str(job),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        try:
            try:
                _out, err = await asyncio.wait_for(proc.communicate(), timeout=limits.worker_wall_seconds)
            except TimeoutError:
                raise TimeLimit(
                    f"processing took longer than {limits.worker_wall_seconds} seconds and was stopped",
                    reason="wall_clock",
                ) from None
        finally:
            if proc.returncode is None:  # overrun, cancellation or error: nothing may outlive the request
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(proc.pid, signal.SIGKILL)
                await proc.wait()
        rc = proc.returncode
        if rc == -signal.SIGXCPU or (rc == -signal.SIGKILL):
            raise TimeLimit(
                f"processing used more than {limits.worker_cpu_seconds} seconds of CPU and was stopped", reason="cpu"
            )
        if rc == EXIT_MEMORY:
            raise ResourceLimit("the document needed more memory than the service allows", reason="memory")
        result_file = job / "result.json"
        tail = err[-2000:].decode("utf-8", "replace")
        if rc != 0 and re.search(r"(?i)memory allocation|cannot allocate memory|MemoryError", tail):
            # a native library (BLAS under numpy) gave up on the address-space cap: the same refusal as MemoryError
            raise ResourceLimit("the document needed more memory than the service allows", reason="memory")
        if rc != 0 or not result_file.exists():
            log.error("worker failed: exit=%s stderr=%s", rc, tail)
            exc = DocumentError("the document could not be processed")
            exc.status, exc.code = 500, "internal_error"
            raise exc
        payload = json.loads(result_file.read_text(encoding="utf-8"))
        STATS["peak_rss_kb"] = max(STATS["peak_rss_kb"], int(payload.get("peak_rss_kb", 0)))
        if "error" in payload:
            raise _error(payload)
        out_file = job / "out.bin"
        return JobResult(payload["result"], out_file.read_bytes() if out_file.exists() else None)
