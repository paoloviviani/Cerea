"""Turn the PNGs the Playwright run wrote ($SHOTS_OUT) into the WebP files under docs/assets.

    uv run --with pillow python scripts/docs-screenshots/finish.py [SHOTS_OUT]

Each file is at most 1600 px wide, WebP, and small. The two home images also get a framed
(browser window) version.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "docs" / "assets"
SHOTS = ASSETS / "screenshots"
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/var/tmp/shots-tmp/out")

# png (in OUT) -> webp (under docs/assets)
PLAIN = {
    "cerea-chat-light": "cerea-chat-light.webp",
    "cerea-chat-dark": "cerea-chat-dark.webp",
    "chat-new-chat": "screenshots/chat-new-chat.webp",
    "chat-web-search": "screenshots/chat-web-search.webp",
    "chat-artifact-table": "screenshots/chat-artifact-table.webp",
    "chat-share-dialog": "screenshots/chat-share-dialog.webp",
    "schedules": "screenshots/schedules.webp",
    "agents-pair-dialog": "screenshots/agents-pair-dialog.webp",
    "agents-phone": "screenshots/agents-phone.webp",
    "agents-session-waiting": "screenshots/agents-session-waiting.webp",
    "agents-session-waiting-dark": "screenshots/agents-session-waiting-dark.webp",
    "agents-workspace-screen": "screenshots/agents-workspace-screen.webp",
    "workspace-agents-connectors": "screenshots/workspace-agents-connectors.webp",
}


def save(image: Image.Image, target: Path, quality: int = 82) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if image.width > 1600:
        image = image.resize((1600, round(image.height * 1600 / image.width)), Image.LANCZOS)
    image.save(target, "WEBP", quality=quality, method=6)
    print(f"{target.relative_to(ROOT)}  {image.width}x{image.height}  {target.stat().st_size // 1024} KB")


def framed(shot: Image.Image, dark: bool) -> Image.Image:
    """The screenshot in a browser window: traffic lights, an address pill, rounded corners, a soft shadow."""
    shot = shot.convert("RGB")
    width = 1516
    height = round(shot.height * width / shot.width)
    shot = shot.resize((width, height), Image.LANCZOS)
    bar = 50
    margin_x, margin_top, margin_bottom = 42, 28, 62
    canvas = Image.new("RGBA", (width + 2 * margin_x, bar + height + margin_top + margin_bottom), (0, 0, 0, 0))
    window = Image.new("RGBA", (width, bar + height), (0, 0, 0, 0))
    chrome = (44, 44, 46) if dark else (238, 238, 240)
    pill = (28, 28, 30) if dark else (255, 255, 255)
    text = (170, 170, 175) if dark else (120, 120, 125)
    draw = ImageDraw.Draw(window)
    draw.rectangle((0, 0, width, bar), fill=chrome)
    for i, colour in enumerate(((255, 95, 87), (254, 188, 46), (40, 200, 64))):
        cx = 24 + i * 22
        draw.ellipse((cx - 7, bar // 2 - 7, cx + 7, bar // 2 + 7), fill=colour)
    draw.rounded_rectangle((width // 2 - 220, 10, width // 2 + 220, bar - 10), radius=15, fill=pill)
    label = "cerea.example.org"
    draw.text((width // 2 - draw.textlength(label) / 2, bar // 2 - 6), label, fill=text)
    window.paste(shot, (0, bar))
    mask = Image.new("L", window.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, window.width - 1, window.height - 1), radius=16, fill=255)
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 90), (margin_x, margin_top + 14), mask)
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    canvas.alpha_composite(shadow)
    canvas.paste(window, (margin_x, margin_top), mask)
    return canvas


for name, target in PLAIN.items():
    source = OUT / f"{name}.png"
    if not source.exists():
        print(f"missing {source}", file=sys.stderr)
        continue
    image = Image.open(source).convert("RGB")
    save(image, ASSETS / target)

for theme in ("light", "dark"):
    source = OUT / f"cerea-chat-{theme}.png"
    if source.exists():
        save(framed(Image.open(source), theme == "dark"), ASSETS / f"cerea-chat-{theme}-framed.webp", 84)
