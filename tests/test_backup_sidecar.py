"""The restic backup sidecar's source (tools/backup/), as static checks.

What a unit test can hold without a Docker daemon: the script parses, nothing
that runs backups floats on `latest`, the override's security posture does not
quietly loosen, and every BACKUP_* / RESTIC_* setting the script reads is
documented in the README. The behaviour (backup, restore, retention, failure
visibility) is proven on throwaway stacks, per release, not here.
Standard library only: `python3 -m unittest`.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SIDECAR = ROOT / "tools" / "backup"
SCRIPT = SIDECAR / "cerea-backup"
OVERRIDE = SIDECAR / "compose.override.example.yaml"
DOCKERFILE = SIDECAR / "Dockerfile"
README = (ROOT / "README.md").read_text(encoding="utf-8")


class SidecarFiles(unittest.TestCase):
    def test_script_is_executable_posix_sh(self):
        self.assertTrue(SCRIPT.stat().st_mode & 0o111, "cerea-backup must be executable")
        self.assertTrue(SCRIPT.read_text().startswith("#!/bin/sh\n"))
        sh = shutil.which("sh")
        self.assertIsNotNone(sh)
        done = subprocess.run([sh, "-n", str(SCRIPT)], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_every_image_is_pinned(self):
        for line in DOCKERFILE.read_text().splitlines():
            if line.startswith("FROM "):
                ref = line.split()[1]
                self.assertRegex(ref, r":[0-9]", f"{ref}: pin a version")
                self.assertNotIn(":latest", ref)
        override = OVERRIDE.read_text()
        self.assertNotIn(":latest", override)
        self.assertRegex(override, r"image: cerea-backup:\d")

    def test_override_stays_unprivileged(self):
        text = OVERRIDE.read_text()
        self.assertNotIn("docker.sock", text, "the sidecar must never get the Docker socket")
        for needle in ("read_only: true", "cap_drop: [ALL]", "no-new-privileges:true"):
            self.assertIn(needle, text)
        # Everything it reads from the stack is mounted read-only.
        for mount in ("./.env:/stack/.env:ro", "authelia-config:/authelia-config:ro", "authelia-data:/authelia-data:ro"):
            self.assertIn(mount, text)
        # The dumps (and .env's copy) live in RAM, never in a volume.
        self.assertRegex(text, r"tmpfs:\n\s+- /work:")

    def test_artifacts_are_the_ones_the_restore_steps_read(self):
        script = SCRIPT.read_text()
        for name in (".env", "postgres.sql", "chat-mongo.archive.gz", "authelia.tgz"):
            self.assertIn(name, script)
            self.assertIn(name, README)
        # The restore steps unpack authelia.tgz expecting these two roots.
        self.assertIn("authelia-config authelia-data", script)
        self.assertIn("/tmp/authelia-config/.", README)

    def test_documented_settings_cover_the_script(self):
        script = SCRIPT.read_text()
        names = set(re.findall(r"\b(?:BACKUP|RESTIC)_[A-Z_]+\b", script))
        # Internals and the restic variables restic itself documents.
        names -= {"BACKUP_WORK_DIR", "BACKUP_STATE_DIR", "BACKUP_ENV_FILE", "BACKUP_RESTORE_DIR",
                  "BACKUP_POSTGRES_HOST", "BACKUP_MONGO_HOST", "RESTIC_REPOSITORY_FILE",
                  "RESTIC_PASSWORD_FILE", "RESTIC_PASSWORD_COMMAND", "RESTIC_CACHE_DIR"}
        for name in sorted(names):
            self.assertIn(name, README, f"{name} is read by cerea-backup but not documented in the README")


if __name__ == "__main__":
    unittest.main()
