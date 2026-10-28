"""Limits and settings, all overridable by environment variables with safe defaults."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import asdict, dataclass, field

from .errors import ConfigError

MiB = 1024 * 1024


def _int(env: Mapping[str, str], key: str, default: int, minimum: int = 1) -> int:
    raw = env.get(key)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{key} must be an integer, got {raw!r}") from exc
    if value < minimum:
        raise ConfigError(f"{key} must be at least {minimum}, got {value}")
    return value


@dataclass(frozen=True)
class Limits:
    """Everything that bounds a request. Defaults are deliberately conservative."""

    max_request_bytes: int = 64 * MiB  # whole HTTP request body
    max_body_bytes: int = 1 * MiB  # the JSON body part
    max_operations: int = 200
    max_images: int = 20
    max_zip_entries: int = 5000
    max_part_bytes: int = 32 * MiB  # one part, uncompressed
    max_total_bytes: int = 256 * MiB  # all parts, uncompressed
    max_ratio: int = 200  # uncompressed / compressed, per large part and overall
    max_image_pixels: int = 40_000_000
    max_image_bytes: int = 20 * MiB
    max_output_bytes: int = 128 * MiB
    worker_memory_bytes: int = 1536 * MiB  # RLIMIT_AS of the worker
    worker_cpu_seconds: int = 20  # RLIMIT_CPU of the worker
    worker_wall_seconds: int = 30  # wall clock, then killed
    max_concurrency: int = 4  # simultaneous worker processes
    max_spec_depth: int = 24  # nesting of the JSON spec (lists inside lists, ...)
    max_blocks: int = 3000  # blocks, slides or sheet entries in one spec, nested items included
    max_slides: int = 200
    max_table_cells: int = 20_000  # all tables of one spec
    max_sheet_cells: int = 100_000  # all cells of one workbook spec
    max_chart_points: int = 5000  # values of one chart
    max_pdf_pages: int = 2000  # a PDF to outline or fill
    max_pdf_fields: int = 5000  # form fields of one PDF
    max_render_pages: int = 6  # images of one look_doc render call
    max_render_px: int = 2000  # the longest side of one rendered image

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Limits:
        e = os.environ if env is None else env
        d = cls()
        p = "CEREA_DOCUMENTS_"
        return cls(
            max_request_bytes=_int(e, p + "MAX_REQUEST_BYTES", d.max_request_bytes),
            max_body_bytes=_int(e, p + "MAX_BODY_BYTES", d.max_body_bytes),
            max_operations=_int(e, p + "MAX_OPERATIONS", d.max_operations),
            max_images=_int(e, p + "MAX_IMAGES", d.max_images),
            max_zip_entries=_int(e, p + "MAX_ZIP_ENTRIES", d.max_zip_entries),
            max_part_bytes=_int(e, p + "MAX_PART_BYTES", d.max_part_bytes),
            max_total_bytes=_int(e, p + "MAX_TOTAL_BYTES", d.max_total_bytes),
            max_ratio=_int(e, p + "MAX_RATIO", d.max_ratio),
            max_image_pixels=_int(e, p + "MAX_IMAGE_PIXELS", d.max_image_pixels),
            max_image_bytes=_int(e, p + "MAX_IMAGE_BYTES", d.max_image_bytes),
            max_output_bytes=_int(e, p + "MAX_OUTPUT_BYTES", d.max_output_bytes),
            worker_memory_bytes=_int(e, p + "WORKER_MEMORY_BYTES", d.worker_memory_bytes, 64 * MiB),
            worker_cpu_seconds=_int(e, p + "WORKER_CPU_SECONDS", d.worker_cpu_seconds),
            worker_wall_seconds=_int(e, p + "WORKER_WALL_SECONDS", d.worker_wall_seconds),
            max_concurrency=_int(e, p + "MAX_CONCURRENCY", d.max_concurrency),
            max_spec_depth=_int(e, p + "MAX_SPEC_DEPTH", d.max_spec_depth),
            max_blocks=_int(e, p + "MAX_BLOCKS", d.max_blocks),
            max_slides=_int(e, p + "MAX_SLIDES", d.max_slides),
            max_table_cells=_int(e, p + "MAX_TABLE_CELLS", d.max_table_cells),
            max_sheet_cells=_int(e, p + "MAX_SHEET_CELLS", d.max_sheet_cells),
            max_chart_points=_int(e, p + "MAX_CHART_POINTS", d.max_chart_points),
            max_pdf_pages=_int(e, p + "MAX_PDF_PAGES", d.max_pdf_pages),
            max_pdf_fields=_int(e, p + "MAX_PDF_FIELDS", d.max_pdf_fields),
            max_render_pages=_int(e, p + "MAX_RENDER_PAGES", d.max_render_pages),
            max_render_px=_int(e, p + "MAX_RENDER_PX", d.max_render_px),
        )

    def to_dict(self) -> dict[str, int]:
        return asdict(self)


@dataclass(frozen=True)
class Settings:
    secret: str | None = None
    allow_no_auth: bool = False
    limits: Limits = field(default_factory=Limits)
    tmpdir: str | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        e = os.environ if env is None else env
        secret = e.get("CEREA_DOCUMENTS_SECRET") or None
        allow = e.get("CEREA_DOCUMENTS_ALLOW_NO_AUTH", "") in ("1", "true", "yes")
        return cls(
            secret=secret,
            allow_no_auth=allow,
            limits=Limits.from_env(e),
            tmpdir=e.get("CEREA_DOCUMENTS_TMPDIR") or None,
        )

    def validate(self) -> None:
        """Refuse to run without a shared secret unless the explicit dev flag is set."""
        if not self.secret and not self.allow_no_auth:
            raise ConfigError(
                "CEREA_DOCUMENTS_SECRET is not set. Set it to the shared secret, or set "
                "CEREA_DOCUMENTS_ALLOW_NO_AUTH=1 for local development only."
            )
