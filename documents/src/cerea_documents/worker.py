"""The sandboxed worker: one fresh process per request. It applies its resource limits before it
touches any document bytes, reads its job from a private directory, and writes a result file.

    python -I -m cerea_documents.worker <job-dir>

Exit codes: 0 result written (success or a clean refusal), 3 out of memory, anything else a crash.
"""

from __future__ import annotations

import json
import resource
import sys
import traceback
from pathlib import Path
from typing import Any

EXIT_MEMORY = 3
MiB = 1024 * 1024


def apply_limits(limits: dict[str, int]) -> None:
    mem = limits["worker_memory_bytes"]
    cpu = limits["worker_cpu_seconds"]
    resource.setrlimit(resource.RLIMIT_AS, (mem, mem))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 2))  # SIGXCPU at the soft limit, SIGKILL after
    resource.setrlimit(
        resource.RLIMIT_FSIZE, (limits["max_output_bytes"] + 4 * MiB, limits["max_output_bytes"] + 4 * MiB)
    )
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def _peak_rss_kb() -> int:
    """This process's own peak resident memory. (getrusage's maxrss would also count the parent's
    pages inherited across fork before exec, so read VmHWM of the current address space instead.)"""
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmHWM:"):
                return int(line.split()[1])
    except (OSError, ValueError):
        pass
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss


def _write(job: Path, result: dict[str, Any], out: bytes | None = None) -> None:
    if out is not None:
        (job / "out.bin").write_bytes(out)
    peak = _peak_rss_kb()
    (job / "result.json").write_text(json.dumps({**result, "peak_rss_kb": peak}), encoding="utf-8")


def run(job: Path) -> int:
    spec = json.loads((job / "job.json").read_text(encoding="utf-8"))
    apply_limits(spec["limits"])
    # imports come after the limits so the memory cap covers everything the request can cause
    from . import core
    from .config import Limits
    from .errors import DocumentError

    limits = Limits(**spec["limits"])
    try:
        data = (job / "doc.bin").read_bytes()
        fmt = spec.get("filename_format")
        body = spec.get("body") or {}
        if spec["kind"] == "outline":
            _write(job, {"result": core.outline(data, fmt, limits)})
        elif spec["kind"] == "read":
            _write(job, {"result": core.read(data, fmt, body, limits)})
        elif spec["kind"] == "edit":
            images = {name: (job / "images" / str(i)).read_bytes() for i, name in enumerate(spec["images"])}
            report, out = core.edit(data, fmt, body, images, limits)
            _write(job, {"result": report}, out)
        elif spec["kind"] == "selftest_spin":  # used by tests: a runaway operation
            while True:
                pass
        elif spec["kind"] == "selftest_alloc":  # used by tests: unbounded memory
            hog = []
            while True:
                hog.append(bytearray(64 * MiB))
        else:
            _write(job, {"error": {"code": "invalid_request", "message": f"unknown job kind {spec['kind']!r}"}})
    except DocumentError as exc:
        _write(job, {**exc.to_dict(), "status": exc.status})
    except MemoryError:
        _write(
            job,
            {
                "error": {
                    "code": "resource_limit",
                    "message": "the document needed more memory than the service allows",
                },
                "status": 413,
            },
        )
        return 0
    except RecursionError:
        _write(
            job,
            {
                "error": {
                    "code": "invalid_document",
                    "message": "the document is nested too deeply",
                    "reason": "too_deep",
                },
                "status": 422,
            },
        )
    except Exception:
        print(traceback.format_exc(limit=8), file=sys.stderr)
        _write(
            job,
            {
                "error": {"code": "internal_error", "message": "unexpected failure while processing the document"},
                "status": 500,
            },
        )
    return 0


def main(argv: list[str]) -> int:
    try:
        return run(Path(argv[1]))
    except MemoryError:
        return EXIT_MEMORY


if __name__ == "__main__":
    sys.exit(main(sys.argv))
