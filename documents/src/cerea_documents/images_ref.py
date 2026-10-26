"""Images referenced by operations: validated bytes by the name the operation uses."""

from __future__ import annotations

from dataclasses import dataclass

from .errors import PatchError
from .images import ImageInfo


@dataclass(frozen=True)
class Img:
    data: bytes
    info: ImageInfo


class ImageSet:
    def __init__(self, images: dict[str, Img] | None = None) -> None:
        self._images = images or {}

    def get(self, name: str) -> Img:
        if name not in self._images:
            have = sorted(self._images) or "none"
            raise PatchError(
                f"image {name!r} was not sent with the request; images sent: {have}. "
                "Send each image as a file part named 'image' whose filename is the name used in the operation."
            )
        return self._images[name]
