"""Image checks: type, header against content, pixel budget. Nothing is decoded beyond the header."""

from __future__ import annotations

import io
from dataclasses import dataclass

from PIL import Image, UnidentifiedImageError

from .config import Limits
from .errors import InvalidRequest

ALLOWED = {"PNG": ("png", "image/png"), "JPEG": ("jpeg", "image/jpeg"), "GIF": ("gif", "image/gif")}
_SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", "PNG"),
    (b"\xff\xd8\xff", "JPEG"),
    (b"GIF87a", "GIF"),
    (b"GIF89a", "GIF"),
)


@dataclass(frozen=True)
class ImageInfo:
    ext: str
    content_type: str
    width: int
    height: int


def inspect_image(data: bytes, name: str, limits: Limits) -> ImageInfo:
    """Return the image's type and size, or raise InvalidRequest. PNG, JPEG and GIF only."""
    Image.MAX_IMAGE_PIXELS = limits.max_image_pixels
    if len(data) > limits.max_image_bytes:
        raise InvalidRequest(
            f"image {name!r} is {len(data)} bytes; the limit is {limits.max_image_bytes}", reason="image_too_large"
        )
    head = data[:512].lstrip()
    if head.startswith((b"<?xml", b"<svg")) or b"<svg" in data[:512]:
        raise InvalidRequest(
            f"image {name!r} is SVG, which is not accepted; rasterise it to PNG first", reason="image_type"
        )
    sniff = next((fmt for sig, fmt in _SIGNATURES if data.startswith(sig)), None)
    if sniff is None:
        raise InvalidRequest(
            f"image {name!r} is not a PNG, JPEG or GIF (its header does not match any of them)", reason="image_type"
        )
    try:
        with Image.open(io.BytesIO(data), formats=[sniff]) as im:
            fmt = im.format
            w, h = im.size
            if fmt != sniff or fmt not in ALLOWED:
                raise InvalidRequest(f"image {name!r}: header says {sniff}, content says {fmt}", reason="image_type")
            if w < 1 or h < 1 or w * h > limits.max_image_pixels:
                raise InvalidRequest(
                    f"image {name!r} is {w}x{h} pixels; the limit is {limits.max_image_pixels} pixels",
                    reason="image_pixels",
                )
            im.verify()
    except InvalidRequest:
        raise
    except Image.DecompressionBombError as exc:
        raise InvalidRequest(
            f"image {name!r} declares far more than the {limits.max_image_pixels} pixels allowed", reason="image_pixels"
        ) from exc
    except (
        UnidentifiedImageError,
        SyntaxError,
        OSError,
        ValueError,
    ) as exc:
        raise InvalidRequest(f"image {name!r} is damaged or oversized: {exc}", reason="image_damaged") from exc
    ext, ctype = ALLOWED[sniff]
    return ImageInfo(ext, ctype, w, h)
