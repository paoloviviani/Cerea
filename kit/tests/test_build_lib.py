"""dev/build-lib.sh: ref resolution and the profile -> image mapping. No docker, no network."""

import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
LIB = KIT / "dev/build-lib.sh"
GIT = shutil.which("git")
ENV = {
    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid",
    "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1",
}


def run(*cmd, cwd=None):
    return subprocess.run(cmd, cwd=cwd, env={**os.environ, **ENV}, capture_output=True, text=True)


def git(cwd, *args):
    p = run("git", *args, cwd=cwd)
    assert p.returncode == 0, p.stderr
    return p.stdout.strip()


def lib(snippet):
    return run("bash", "-c", f'. "{LIB}"; {snippet}')


@unittest.skipUnless(GIT, "git is not installed")
class ResolveRefTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="build-lib-test-"))
        origin, cls.clone = cls.tmp / "origin", cls.tmp / "clone"
        origin.mkdir()
        git(origin, "init", "-q", "-b", "main")
        (origin / "f").write_text("1")
        git(origin, "add", "-A")
        git(origin, "commit", "-q", "-m", "one")
        git(origin, "tag", "v1.0.0")
        cls.old = git(origin, "rev-parse", "HEAD")
        git(cls.tmp, "clone", "-q", str(origin), str(cls.clone))
        (origin / "f").write_text("2")
        git(origin, "commit", "-qam", "two")
        cls.new = git(origin, "rev-parse", "HEAD")
        git(cls.clone, "fetch", "-q", "--tags", "origin")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_branch_name_means_origin_not_the_stale_local_branch(self):
        self.assertEqual(git(self.clone, "rev-parse", "main"), self.old)  # local is behind
        p = lib(f'resolve_ref "{self.clone}" main')
        self.assertEqual(p.stdout.strip(), self.new)

    def test_tag_and_sha(self):
        self.assertEqual(lib(f'resolve_ref "{self.clone}" v1.0.0').stdout.strip(), self.old)
        self.assertEqual(lib(f'resolve_ref "{self.clone}" {self.new[:9]}').stdout.strip(), self.new)

    def test_unknown_ref_fails(self):
        self.assertNotEqual(lib(f'resolve_ref "{self.clone}" nope').returncode, 0)


class ProfileImagesTest(unittest.TestCase):
    def mapping(self):
        out = lib(f'profile_images "{KIT / "compose.yaml"}"').stdout.split("\n")
        return {tuple(line.split()) for line in out if line}

    def test_documents_needs_the_redaction_image(self):
        m = self.mapping()
        self.assertIn(("documents", "redaction-image"), m)
        self.assertIn(("redaction", "redaction-image"), m)
        self.assertIn(("chat", "cerea-image"), m)
        self.assertIn(("gateway", "gateway-image"), m)

    def test_every_local_image_anchor_has_a_build_case(self):
        script = (KIT / "dev/build.sh").read_text()
        for _, anchor in self.mapping():
            self.assertIn(f"{anchor}) build_", script)

    def test_build_sh_selects_images_by_profile(self):
        # The loop in build.sh, run on its own with the homelab-like profile set.
        p = lib(
            'profiles=gateway,chat,documents; all=0; '
            'wants() { [ "$all" = 1 ] || [ -z "$profiles" ] || [[ ",$profiles," == *",$1,"* ]]; }; '
            'r=0; while read -r prof a; do wants "$prof" || continue; '
            f'[ "$a" = redaction-image ] && r=1; done < <(profile_images "{KIT / "compose.yaml"}"); echo $r'
        )
        self.assertEqual(p.stdout.strip(), "1")


if __name__ == "__main__":
    unittest.main()
