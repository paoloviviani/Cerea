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
        # The image is local-built and published nowhere: the upgrade flow's
        # `docker compose pull` must skip the service, or it fails the whole
        # pull with "pull access denied".
        self.assertRegex(text, r"pull_policy:\s*never")
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
                  "BACKUP_POSTGRES_HOST", "BACKUP_MONGO_HOST", "BACKUP_OBJECTS_DIR", "RESTIC_REPOSITORY_FILE",
                  "RESTIC_PASSWORD_FILE", "RESTIC_PASSWORD_COMMAND", "RESTIC_CACHE_DIR"}
        for name in sorted(names):
            self.assertIn(name, README, f"{name} is read by cerea-backup but not documented in the README")

    def test_objects_are_backed_up_and_restored(self):
        script = SCRIPT.read_text()
        override = OVERRIDE.read_text()
        # Opt-in switch mirrors BACKUP_MONGO, and is on with the S3 store.
        self.assertRegex(script, r"BACKUP_OBJECTS:-auto")
        self.assertIn("CHAT_BLOB_STORE", script)
        # The bucket is read from the chat's own settings, through env-only rclone.
        for name in ("CHAT_S3_ENDPOINT", "CHAT_S3_BUCKET", "CHAT_S3_REGION", "CHAT_S3_ACCESS_KEY_ID",
                     "CHAT_S3_SECRET_ACCESS_KEY", "CHAT_S3_FORCE_PATH_STYLE", "CHAT_S3_PREFIX"):
            self.assertIn(name, script)
        self.assertIn("RCLONE_CONFIG_CHATOBJECTS_TYPE=s3", script)
        # Mongo first, then the objects, then one snapshot of the dump dir and /objects.
        self.assertLess(script.index("STEP=mongo;"), script.index("STEP=objects;"))
        self.assertIn('"$RUN_DIR" "$OBJECTS_DIR"', script)
        self.assertIn("BACKUP FAILED at step", script)
        # The staging copy is a persistent volume (never the RAM disk), and the sidecar
        # reaches the bundled RustFS over its internal network, still unprivileged.
        self.assertIn("backup-objects:/objects", override)
        self.assertRegex(override, r"networks: \[default, objects\]")
        self.assertRegex(override, r"volumes:\n  backup-state:\n  backup-objects:")
        # Restore brings the objects back beside the dump files, and the README documents the copy back.
        self.assertIn('"$target/objects"', script)
        for needle in ("BACKUP_OBJECTS", "rclone/rclone:1.73.0", "rc copy /data/objects", "rc sync", "--wait rustfs"):
            self.assertIn(needle, README)
        self.assertNotIn("rustfs-data` volume with the rest", README)


class ObjectsStep(unittest.TestCase):
    """The step's decisions, run for real with stub binaries (no Docker)."""

    def run_now(self, env, tmp):
        import os
        stub = Path(tmp) / "stub"
        stub.mkdir()
        log = Path(tmp) / "calls"
        for name, body in {
            "pg_dumpall": 'echo "-- PostgreSQL database cluster dump complete"',
            "mongodump": 'echo mongodump >> "$CALLS"; for a in "$@"; do case $a in --archive=*) echo m | gzip > "${a#--archive=}";; esac; done',
            "rclone": 'echo "rclone $1" >> "$CALLS"; case $1 in size) echo \'{"count":2,"bytes":9}\';; esac',
            "restic": 'echo "restic $1 $*" >> "$CALLS"; case $1 in cat) exit 0;; esac',
            "sqlite3": "exit 0",
        }.items():
            f = stub / name
            f.write_text("#!/bin/sh\n" + body + "\n")
            f.chmod(0o755)
        for d in ("work", "state", "objects", "ac", "ad"):
            (Path(tmp) / d).mkdir()
        (Path(tmp) / "env").write_text("X=1\n")
        # The script's fixed paths are rewritten to the sandbox, only for this run.
        text = SCRIPT.read_text().replace("WORK=/work", f"WORK={tmp}/work").replace(
            "tar -cf \"$RUN_DIR/authelia.tar\" -C / --exclude='authelia-data/*.sqlite3*' authelia-config authelia-data",
            f"mkdir -p {tmp}/ac/authelia-config {tmp}/ac/authelia-data; tar -cf \"$RUN_DIR/authelia.tar\" -C {tmp}/ac authelia-config authelia-data",
        ).replace("/authelia-data/*.sqlite3", f"{tmp}/ad/*.sqlite3")
        script = Path(tmp) / "cerea-backup"
        script.write_text(text)
        e = {"PATH": f"{stub}:{os.environ['PATH']}", "CALLS": str(log), "POSTGRES_PASSWORD": "x",
             "RESTIC_REPOSITORY": "/r", "RESTIC_PASSWORD": "p", "BACKUP_STATE_DIR": f"{tmp}/state",
             "BACKUP_ENV_FILE": f"{tmp}/env", "BACKUP_OBJECTS_DIR": f"{tmp}/objects", "BACKUP_MONGO": "yes"}
        e.update(env)
        done = subprocess.run(["sh", str(script), "now"], env=e, capture_output=True, text=True)
        return done, (log.read_text() if log.exists() else "")

    def test_on_with_s3_in_order_and_off_otherwise(self):
        import tempfile
        s3 = {"CHAT_BLOB_STORE": "s3", "CHAT_S3_BUCKET": "cerea", "CHAT_S3_ENDPOINT": "http://rustfs:9000",
              "CHAT_S3_ACCESS_KEY_ID": "k", "CHAT_S3_SECRET_ACCESS_KEY": "s"}
        with tempfile.TemporaryDirectory() as tmp:
            done, calls = self.run_now(s3, tmp)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertLess(calls.index("mongodump"), calls.index("rclone sync"))
            self.assertIn(f"{tmp}/work/cerea {tmp}/objects", calls)   # one snapshot, both paths
            self.assertNotIn("CHAT_S3_SECRET", done.stdout + done.stderr)
        with tempfile.TemporaryDirectory() as tmp:
            done, calls = self.run_now({"CHAT_BLOB_STORE": ""}, tmp)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertNotIn("rclone", calls)
            self.assertNotIn(f"{tmp}/objects", calls)
        with tempfile.TemporaryDirectory() as tmp:
            done, calls = self.run_now({**s3, "BACKUP_OBJECTS": "no"}, tmp)
            self.assertNotIn("rclone", calls)

    def test_a_failing_object_store_fails_the_run_at_step_objects(self):
        import tempfile
        # a missing bucket name is a clear failure, not a silent skip
        with tempfile.TemporaryDirectory() as tmp:
            done, calls = self.run_now({"CHAT_BLOB_STORE": "s3"}, tmp)
            self.assertNotEqual(done.returncode, 0)
            self.assertIn("BACKUP FAILED at step 'objects'", done.stderr)
            self.assertNotIn("restic backup", calls)


if __name__ == "__main__":
    unittest.main()
