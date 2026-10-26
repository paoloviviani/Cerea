"""Resource limits: a runaway operation is killed by the time limit, memory and CPU are capped."""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from cerea_documents import runner
from cerea_documents.config import Limits, Settings
from cerea_documents.errors import ResourceLimit, TimeLimit

from .conftest import SECRET, make_client, post
from .fixtures import make_docx

SMALL = replace(Limits(), worker_wall_seconds=2, worker_cpu_seconds=30, worker_memory_bytes=512 * 1024 * 1024)


def worker_processes() -> list[int]:
    """PIDs of live cerea_documents.worker processes (scanned directly: no pgrep self-match)."""
    out = []
    for p in Path("/proc").iterdir():
        if p.name.isdigit():
            try:
                cmd = (p / "cmdline").read_bytes().split(b"\0")
            except OSError:
                continue
            if b"cerea_documents.worker" in cmd:
                out.append(int(p.name))
    return out


def run(kind: str, limits: Limits) -> Any:
    return asyncio.run(runner.run_job(kind, b"", filename_format=None, body=None, images={}, limits=limits))


def test_runaway_operation_is_killed_by_the_wall_clock_and_leaves_nothing_behind() -> None:
    # a worker that never finishes and burns no CPU budget quickly: only the wall clock can stop it
    lim = replace(SMALL, worker_wall_seconds=2, worker_cpu_seconds=60)
    t0 = time.monotonic()
    with pytest.raises(TimeLimit) as ei:
        run("selftest_spin", lim)
    assert 1.5 < time.monotonic() - t0 < 10
    assert ei.value.status == 504 and ei.value.reason == "wall_clock"
    time.sleep(0.3)
    assert worker_processes() == [], "the killed worker must not outlive the request"


def test_cpu_limit_kills_a_spinning_worker_before_the_wall_clock() -> None:
    lim = replace(SMALL, worker_wall_seconds=30, worker_cpu_seconds=1)
    t0 = time.monotonic()
    with pytest.raises(TimeLimit) as ei:
        run("selftest_spin", lim)
    assert time.monotonic() - t0 < 10 and ei.value.reason == "cpu"
    assert worker_processes() == []


def test_memory_limit_stops_unbounded_allocation_cleanly() -> None:
    lim = replace(SMALL, worker_wall_seconds=30, worker_memory_bytes=256 * 1024 * 1024)
    t0 = time.monotonic()
    with pytest.raises(ResourceLimit) as ei:
        run("selftest_alloc", lim)
    assert time.monotonic() - t0 < 15 and ei.value.status == 413
    assert worker_processes() == []


def test_runaway_through_the_http_api_returns_504_and_the_service_keeps_serving(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real = runner.run_job
    state = {"n": 0}

    async def hijack(kind: str, doc: bytes, **kw: Any) -> Any:
        state["n"] += 1
        return await real("selftest_spin" if state["n"] == 1 else kind, doc, **kw)

    monkeypatch.setattr("cerea_documents.api.run_job", hijack)
    with make_client(worker_wall_seconds=2) as c:
        t0 = time.monotonic()
        r = post(c, "/v1/outline", "a.docx", make_docx())
        assert r.status_code == 504 and r.json()["error"]["code"] == "time_limit"
        assert time.monotonic() - t0 < 10
        time.sleep(0.3)
        assert worker_processes() == []
        r = post(c, "/v1/outline", "a.docx", make_docx())  # the next request is unaffected
        assert r.status_code == 200


def test_each_request_gets_a_fresh_process_and_a_private_directory(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []
    real = asyncio.create_subprocess_exec

    async def spy(*a: Any, **kw: Any) -> Any:
        seen.append(str(kw.get("cwd")))
        return await real(*a, **kw)

    monkeypatch.setattr("cerea_documents.runner.asyncio.create_subprocess_exec", spy)
    with make_client() as c:
        post(c, "/v1/outline", "a.docx", make_docx())
        post(c, "/v1/outline", "a.docx", make_docx())
    assert len(seen) == 2 and seen[0] != seen[1] and all(not os.path.exists(d) for d in seen), (
        "job directories are removed"
    )


def test_worker_applies_its_rlimits_before_touching_the_document(tmp_path: Path) -> None:
    import json
    import subprocess
    import sys

    job = tmp_path / "job"
    (job / "images").mkdir(parents=True)
    (job / "doc.bin").write_bytes(make_docx())
    lim = replace(Limits(), worker_memory_bytes=300 * 1024 * 1024, worker_cpu_seconds=7)
    (job / "job.json").write_text(
        json.dumps(
            {"kind": "selftest_limits", "filename_format": None, "body": None, "images": [], "limits": lim.to_dict()}
        )
    )
    code = (
        "import resource,json,sys;"
        "from cerea_documents.worker import apply_limits;"
        "apply_limits(json.load(open(sys.argv[1]))['limits']);"
        "print(resource.getrlimit(resource.RLIMIT_AS)[0], resource.getrlimit(resource.RLIMIT_CPU)[0], resource.getrlimit(resource.RLIMIT_CORE)[0])"
    )
    out = subprocess.run(
        [sys.executable, "-I", "-c", code, str(job / "job.json")], capture_output=True, text=True, check=True
    ).stdout.split()
    assert out == [str(300 * 1024 * 1024), "7", "0"]


def test_concurrency_is_bounded() -> None:
    from cerea_documents.api import create_app

    assert create_app(Settings(secret=SECRET, limits=replace(Limits(), max_concurrency=2)))
