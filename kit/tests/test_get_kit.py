"""get-kit.sh against a throwaway local repository: no network, no docker."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "get-kit.sh"
GIT = shutil.which("git")

ENV = {
    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid",
    "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1",
}


def run(*cmd, cwd=None):
    env = {**os.environ, **ENV}
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)


def git(cwd, *args):
    p = run("git", *args, cwd=cwd)
    assert p.returncode == 0, p.stderr
    return p.stdout.strip()


@unittest.skipUnless(GIT, "git is not installed")
class GetKitTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="get-kit-test-"))
        src = cls.tmp / "src"
        src.mkdir()
        git(src, "init", "-q", "-b", "main")

        def commit(tag, kit=True, extra=""):
            (src / "README.md").write_text("the application " + tag)
            if kit:
                (src / "kit").mkdir(exist_ok=True)
                (src / "kit/compose.yaml").write_text("name: ${COMPOSE_PROJECT_NAME:-cerea}\n")
                (src / "kit/configure").write_text("#!/bin/sh\n")
                (src / "kit/.gitignore").write_text(".env\n.env.bak-*\nfirst-sign-in.txt\nproxy.d/*.caddy\ncompose.override.yaml\n")
                (src / "kit/VERSION").write_text(tag + extra)
            git(src, "add", "-A")
            git(src, "commit", "-q", "-m", tag)
            git(src, "tag", "-a", "-m", tag, tag)

        commit("v0.9.0", kit=False)  # from before the kit moved in
        commit("v1.0.0")
        commit("v1.0.1")
        commit("v1.9.0")
        commit("v1.10.0")
        commit("v1.11.0-rc1")  # a pre-release is never "latest"
        cls.remote = cls.tmp / "remote.git"
        git(cls.tmp, "clone", "-q", "--bare", str(src), str(cls.remote))
        git(cls.remote, "config", "uploadpack.allowFilter", "true")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.work = Path(tempfile.mkdtemp(dir=self.tmp))

    def kit(self, *args, cwd=None):
        return run("sh", str(SCRIPT), "--repo", str(self.remote), *args, cwd=cwd or self.work)

    def install(self, version="v1.0.0"):
        p = self.kit("--version", version, "--dir", str(self.work / "inst"))
        self.assertEqual(p.returncode, 0, p.stderr)
        return self.work / "inst"

    def test_help(self):
        p = run("sh", str(SCRIPT), "--help")
        self.assertEqual(p.returncode, 0)
        for flag in ("--version", "--dir", "--repo", "--upgrade", "--from"):
            self.assertIn(flag, p.stdout)

    def test_usage_error(self):
        p = run("sh", str(SCRIPT), "--bogus")
        self.assertEqual(p.returncode, 2)
        self.assertEqual(run("sh", str(SCRIPT), "--version").returncode, 2)

    def test_fresh_install_is_sparse(self):
        inst = self.install("v1.0.0")
        self.assertTrue((inst / "kit/compose.yaml").is_file())
        self.assertEqual(sorted(p.name for p in inst.iterdir()), [".git", "kit"])
        self.assertEqual((inst / "kit/VERSION").read_text(), "v1.0.0")

    def test_default_is_newest_release_tag(self):
        p = self.kit("--dir", str(self.work / "inst"))
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual((self.work / "inst/kit/VERSION").read_text(), "v1.10.0")  # not v1.9.0, not the rc

    def test_default_dir_is_cerea(self):
        p = self.kit("--version", "v1.0.0")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue((self.work / "cerea/kit/compose.yaml").is_file())

    def test_refuses_a_foreign_directory(self):
        d = self.work / "foreign"
        d.mkdir()
        (d / "mine.txt").write_text("keep")
        p = self.kit("--version", "v1.0.0", "--dir", str(d))
        self.assertEqual(p.returncode, 1)
        self.assertIn("not empty", p.stderr)
        self.assertEqual([x.name for x in d.iterdir()], ["mine.txt"])

    def test_accepts_an_empty_directory(self):
        d = self.work / "empty"
        d.mkdir()
        self.assertEqual(self.kit("--version", "v1.0.0", "--dir", str(d)).returncode, 0)
        self.assertTrue((d / "kit/compose.yaml").is_file())

    def test_refuses_to_reinstall_over_a_checkout(self):
        inst = self.install()
        p = self.kit("--version", "v1.0.1", "--dir", str(inst))
        self.assertEqual(p.returncode, 1)
        self.assertIn("--upgrade", p.stderr)

    def test_unknown_tag(self):
        p = self.kit("--version", "v7.7.7", "--dir", str(self.work / "inst"))
        self.assertEqual(p.returncode, 1)
        self.assertIn("v7.7.7", p.stderr)
        self.assertIn("v1.10.0", p.stderr)  # names the newest tags
        self.assertFalse((self.work / "inst").exists())

    def test_tag_without_the_kit(self):
        p = self.kit("--version", "v0.9.0", "--dir", str(self.work / "inst"))
        self.assertEqual(p.returncode, 1)
        self.assertIn("does not contain the deploy kit", p.stderr)
        self.assertFalse((self.work / "inst").exists())  # cleaned up

    def test_upgrade_keeps_operator_files(self):
        inst = self.install("v1.0.0")
        kit = inst / "kit"
        (kit / ".env").write_text("SECRET='x'\nCOMPOSE_PROJECT_NAME='mine'\n")
        (kit / "proxy.d").mkdir(exist_ok=True)
        (kit / "proxy.d/mine.caddy").write_text("route")
        (kit / "first-sign-in.txt").write_text("pw")
        (kit / "backup-1").mkdir()
        (kit / "backup-1/pg.sql").write_text("dump")
        before = (kit / ".env").read_bytes()
        p = run("sh", str(SCRIPT), "--upgrade", "--version", "v1.0.1", cwd=kit)  # from inside kit/
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual((kit / "VERSION").read_text(), "v1.0.1")
        self.assertEqual((kit / ".env").read_bytes(), before)
        for f in ("proxy.d/mine.caddy", "first-sign-in.txt", "backup-1/pg.sql"):
            self.assertTrue((kit / f).exists(), f)
        self.assertIn("v1.0.0 -> v1.0.1", p.stdout)
        # and again, to the newest, naming the checkout instead of standing in it
        p = self.kit("--upgrade", "--dir", str(inst))
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual((kit / "VERSION").read_text(), "v1.10.0")
        self.assertEqual((kit / ".env").read_bytes(), before)
        self.assertIn("Already at", self.kit("--upgrade", "--dir", str(inst)).stdout)

    def test_upgrade_refuses_a_local_edit_it_would_lose(self):
        inst = self.install("v1.0.0")
        (inst / "kit/VERSION").write_text("edited")
        p = self.kit("--upgrade", "--dir", str(inst), "--version", "v1.0.1")
        self.assertEqual(p.returncode, 1)
        self.assertIn("edited a file git tracks", p.stderr)
        self.assertEqual((inst / "kit/VERSION").read_text(), "edited")

    def test_upgrade_outside_a_checkout(self):
        p = self.kit("--upgrade")
        self.assertEqual(p.returncode, 1)
        self.assertIn("not inside a checkout", p.stderr)
        d = self.work / "plain"
        d.mkdir()
        self.assertEqual(self.kit("--upgrade", "--dir", str(d)).returncode, 1)
        other = self.work / "other"  # somebody's own git repository: not ours to touch
        other.mkdir()
        git(other, "init", "-q")
        p = self.kit("--upgrade", "--dir", str(other))
        self.assertEqual(p.returncode, 1)
        self.assertIn("not a checkout made by", p.stderr)

    # --from ------------------------------------------------------------------
    def old_install(self, env_text, compose="name: ${COMPOSE_PROJECT_NAME:-cerea}\n", name="old-kit"):
        old = self.work / name
        (old / "proxy.d").mkdir(parents=True)
        (old / "compose.yaml").write_text(compose)
        (old / "configure").write_text("#!/bin/sh\n")
        (old / ".env").write_text(env_text)
        (old / ".env").chmod(0o600)
        (old / "proxy.d/mine.caddy").write_text("route")
        (old / "proxy.d/README.md").write_text("not operator-owned")
        (old / "compose.override.yaml").write_text("services: {}\n")
        (old / "first-sign-in.txt").write_text("pw")
        return old

    def migrate(self, old, version="v1.0.0"):
        return self.kit("--version", version, "--dir", str(self.work / "new"), "--from", str(old))

    def test_from_keeps_the_project_name_of_the_env(self):
        old = self.old_install("SECRET='x'\nCOMPOSE_PROJECT_NAME='distinct'\n")
        before = (old / ".env").read_bytes()
        p = self.migrate(old)
        self.assertEqual(p.returncode, 0, p.stderr)
        new = self.work / "new/kit"
        self.assertEqual((new / ".env").read_bytes(), before)
        self.assertEqual((old / ".env").read_bytes(), before)  # the old install is left as it was
        self.assertEqual((new / ".env").stat().st_mode & 0o777, 0o600)
        self.assertEqual((new / "proxy.d/mine.caddy").read_text(), "route")
        self.assertFalse((new / "proxy.d/README.md").exists())  # only *.caddy is operator-owned
        self.assertTrue((new / "compose.override.yaml").is_file())
        self.assertTrue((new / "first-sign-in.txt").is_file())
        self.assertIn("docker compose down", p.stdout)
        self.assertIn("docker compose up -d --wait", p.stdout)
        self.assertNotIn("down -v", p.stdout.split("Prefer a clean start")[0])  # never tells you to delete volumes

    def test_from_pins_the_default_name_of_the_old_compose_file(self):
        # no COMPOSE_PROJECT_NAME in .env: a compose.yaml with `name:` wins over the directory
        old = self.old_install("SECRET='x'", name="Some Dir")  # no trailing newline either
        p = self.migrate(old)
        self.assertEqual(p.returncode, 0, p.stderr)
        lines = (self.work / "new/kit/.env").read_text().splitlines()
        self.assertEqual(lines, ["SECRET='x'", "COMPOSE_PROJECT_NAME='cerea'"])

    def test_from_falls_back_to_the_directory_name(self):
        old = self.old_install("SECRET='x'\n", compose="services: {}\n", name="Old-Kit.v1")
        p = self.migrate(old)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("COMPOSE_PROJECT_NAME='old-kitv1'", (self.work / "new/kit/.env").read_text())

    def test_from_refusals(self):
        self.assertEqual(self.migrate(self.work / "nope").returncode, 1)
        bare = self.work / "bare"
        bare.mkdir()
        self.assertEqual(self.migrate(bare).returncode, 1)
        unconfigured = self.old_install("")
        (unconfigured / ".env").unlink()
        p = self.migrate(unconfigured)
        self.assertEqual(p.returncode, 1)
        self.assertIn("no .env", p.stderr)
        self.assertFalse((self.work / "new").exists())

    def test_from_and_upgrade_are_exclusive(self):
        self.assertEqual(self.kit("--upgrade", "--from", str(self.work)).returncode, 2)


if __name__ == "__main__":
    unittest.main()
