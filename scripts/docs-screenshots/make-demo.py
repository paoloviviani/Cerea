"""Join the clips demo.spec.ts recorded into docs/assets/cerea-demo.mp4 and cerea-demo.webp.

    uv run --with imageio-ffmpeg --with pillow python scripts/docs-screenshots/make-demo.py [DEMO_OUT]

DEMO_OUT (default /var/tmp/readme-tmp/demo) holds clip-a/b/c.webm and clips.json (where each clip's
scripted part starts). The clips are trimmed there, scaled onto one 1280x800 light canvas (the phone
clip centred), joined, and written as H.264 (README link) and an animated WebP (README image).
There is no system ffmpeg on the box: imageio-ffmpeg bundles one.
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import imageio_ffmpeg
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "docs" / "assets"
SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "/var/tmp/readme-tmp/demo")
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
W, H, FPS = 1280, 800, 20
BG = "0xF6F4EF"
# Clip -> seconds to keep, counted from where the scripted part starts (None = to the end).
KEEP = {"a": None, "b": None, "c": None}
offsets = json.loads((SRC / "clips.json").read_text())


def run(*args: str) -> None:
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", *args], check=True)


tmp = Path(tempfile.mkdtemp(prefix="demo-", dir=SRC))
parts = []
for name in ("a", "b", "c"):
    out = tmp / f"{name}.mp4"
    start = max(offsets[name] - 0.3, 0)
    # The phone clip is 390x844: fit its height into the canvas and centre it.
    fit = f"scale=-2:{H - 40}" if name == "c" else f"scale={W}:{H}"
    vf = f"fps={FPS},{fit},pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color={BG},format=yuv420p"
    run("-ss", f"{start:.2f}", "-i", str(SRC / f"clip-{name}.webm"), "-vf", vf,
        "-c:v", "libx264", "-crf", "24", "-preset", "slow", "-an", str(out))
    parts.append(out)

# Short cross-fades between clips.
FADE = 0.5


def duration(p: Path) -> float:
    r = subprocess.run([FFMPEG, "-i", str(p)], capture_output=True, text=True)
    h, m, s = r.stderr.split("Duration:")[1].split(",")[0].strip().split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


d = [duration(p) for p in parts]
graph = (
    f"[0][1]xfade=transition=fade:duration={FADE}:offset={d[0] - FADE:.2f}[x];"
    f"[x][2]xfade=transition=fade:duration={FADE}:offset={d[0] + d[1] - 2 * FADE:.2f},format=yuv420p[v]"
)
mp4 = ASSETS / "cerea-demo.mp4"
run(*sum((["-i", str(p)] for p in parts), []), "-filter_complex", graph, "-map", "[v]",
    "-c:v", "libx264", "-crf", "26", "-preset", "slow", "-movflags", "+faststart", str(mp4))

# The animated WebP: 960 px wide, 10 fps, frames through Pillow (no libwebp in the bundled ffmpeg).
frames_dir = tmp / "frames"
frames_dir.mkdir()
run("-i", str(mp4), "-vf", "fps=10,scale=960:-2", str(frames_dir / "f%04d.png"))
frames = [Image.open(f).convert("RGB") for f in sorted(frames_dir.glob("f*.png"))]
webp = ASSETS / "cerea-demo.webp"
frames[0].save(webp, save_all=True, append_images=frames[1:], duration=100, loop=0,
               quality=55, method=6)
print(f"{mp4} {mp4.stat().st_size / 1e6:.1f} MB, {sum(d) - 2 * FADE:.1f} s")
print(f"{webp} {webp.stat().st_size / 1e6:.1f} MB, {len(frames)} frames")
