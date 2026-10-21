"""The MongoDB image choice, its check, and tools/mongo-upgrade's logic.

Standard library only: `python3 -m unittest`. No Docker: the upgrade tool's
commands go through a fake runner, so what is tested is the sequence it issues,
how it resumes, and what it refuses. The real upgrade (5.0 -> 8.0 on a data
volume) needs an AVX host and was NOT exercised by these tests.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import json
import re
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent


def _load(name: str, path: Path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    loader.exec_module(module)
    return module


cfg = _load("configure_mongo_test", ROOT / "configure")
up = _load("mongo_upgrade_test", ROOT / "tools" / "mongo-upgrade")
TEMPLATE = (ROOT / ".env.example").read_text(encoding="utf-8")

AVX_CPUINFO = "processor : 0\nflags\t\t: fpu sse4_2 avx avx2 aes\n"
NO_AVX_CPUINFO = "processor : 0\nflags\t\t: fpu sse4_2 aes\n"


class Detection(unittest.TestCase):
    def test_avx_from_flags(self):
        self.assertTrue(cfg.cpu_has_avx(AVX_CPUINFO, "x86_64"))
        self.assertFalse(cfg.cpu_has_avx(NO_AVX_CPUINFO, "x86_64"))

    def test_avx_is_a_whole_word(self):
        # avx2 alone, or a model name containing "avx", is not the avx flag.
        self.assertFalse(cfg.cpu_has_avx("flags : avx2 avx512f\nmodel name : avx\n", "x86_64"))

    def test_unknown_is_none(self):
        self.assertIsNone(cfg.cpu_has_avx(None, "x86_64"))  # no /proc/cpuinfo (macOS)
        self.assertIsNone(cfg.cpu_has_avx("", "x86_64"))
        self.assertIsNone(cfg.cpu_has_avx("Features : fp asimd\n", "aarch64"))
        self.assertIsNone(cfg.cpu_has_avx("processor : 0\n", "x86_64"))  # no flags line

    def test_kernel_upstream_version(self):
        self.assertEqual(cfg.kernel_version("7.0.0-38-generic"), (7, 0, 0))
        self.assertEqual(cfg.kernel_version("6.19"), (6, 19, 0))
        self.assertEqual(cfg.kernel_version("5.15.0-1052-aws"), (5, 15, 0))
        self.assertIsNone(cfg.kernel_version("weird"))

    def test_kernel_range_is_inclusive_at_both_ends(self):
        broken = {
            "6.18.99": False, "6.19.0": True, "6.19": True, "6.20.1": True, "7.0.0-38-generic": True,
            "7.0.13": True, "7.0.13-1-generic": True, "7.0.14": False, "7.0.14-2-generic": False,
            "7.1.0": False, "6.8.0-40-generic": False,
        }
        for release, expected in broken.items():
            self.assertIs(cfg.mongo8_kernel_broken(release), expected, release)
        self.assertIsNone(cfg.mongo8_kernel_broken("weird"))


class Choice(unittest.TestCase):
    def test_capable_host_gets_8(self):
        self.assertEqual(cfg.choose_mongo(True, "6.8.0-40-generic").image, cfg.MONGO_DEFAULT)
        self.assertEqual(cfg.choose_mongo(True, "7.0.14-1-generic").image, cfg.MONGO_DEFAULT)

    def test_no_avx_gets_4_4_and_says_why(self):
        choice = cfg.choose_mongo(False, "6.8.0")
        self.assertEqual(choice.image, cfg.MONGO_FALLBACK)
        self.assertIn("AVX", choice.reason)

    def test_affected_kernel_gets_4_4_and_says_why(self):
        for release in ("6.19.2", "7.0.0-38-generic", "7.0.13"):
            choice = cfg.choose_mongo(True, release)
            self.assertEqual(choice.image, cfg.MONGO_FALLBACK, release)
            self.assertIn(release, choice.reason)

    def test_unknown_is_safe(self):
        self.assertEqual(cfg.choose_mongo(None, "6.8.0").image, cfg.MONGO_FALLBACK)
        self.assertEqual(cfg.choose_mongo(True, "weird").image, cfg.MONGO_FALLBACK)

    def test_pins_are_exact_patch_versions(self):
        self.assertRegex(cfg.MONGO_DEFAULT, r"^mongo:8\.0\.\d+$")
        self.assertRegex(cfg.MONGO_FALLBACK, r"^mongo:4\.4\.\d+$")

    def test_compose_default_is_the_fallback(self):
        compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
        self.assertIn("image: ${MONGO_IMAGE:-" + cfg.MONGO_FALLBACK + "}", compose)

    def test_example_shows_the_default_and_is_a_known_key(self):
        _, commented = cfg.template_keys(TEMPLATE)
        self.assertIn("MONGO_IMAGE", commented)
        self.assertIn(f"# MONGO_IMAGE='{cfg.MONGO_DEFAULT}'", TEMPLATE)

    def test_upgrade_path_ends_at_the_default(self):
        self.assertEqual(up.STEPS[-1][1], cfg.MONGO_DEFAULT)
        self.assertEqual([s[0] for s in up.STEPS], ["5.0", "6.0", "7.0", "8.0"])
        for _, image, _ in up.STEPS:
            self.assertRegex(image, r"^mongo:\d+\.\d+\.\d+$")


def _build(existing=None, mongo=None):
    a = cfg.Answers(origin="https://chat.example.org", admin_email="ops@example.org")
    return cfg.build(a, existing or {}, TEMPLATE, None, mongo)


class WritesTheChoice(unittest.TestCase):
    def test_fresh_install_writes_the_choice_and_the_reason(self):
        choice = cfg.choose_mongo(False, "6.8.0")
        result = _build(mongo=choice)
        self.assertEqual(result.values["MONGO_IMAGE"], cfg.MONGO_FALLBACK)
        self.assertIn(choice.reason, result.notes)
        text = cfg.render(TEMPLATE, result.values, "# h")
        self.assertIn(f"MONGO_IMAGE='{cfg.MONGO_FALLBACK}'", text)
        self.assertIn("# Without this line compose runs", text)  # the comment stays above it
        self.assertEqual(cfg.parse_env(text)["MONGO_IMAGE"], cfg.MONGO_FALLBACK)

    def test_operator_override_is_kept(self):
        first = _build(mongo=cfg.choose_mongo(True, "6.8.0")).values
        first["MONGO_IMAGE"] = "mongo:7.0.45"
        again = _build(existing=first, mongo=cfg.choose_mongo(True, "6.8.0"))
        self.assertEqual(again.values["MONGO_IMAGE"], "mongo:7.0.45")

    def test_existing_env_without_the_key_is_not_switched(self):
        # Its data is on 4.4; 8 cannot open it. Only tools/mongo-upgrade moves it.
        values = _build(mongo=cfg.choose_mongo(True, "6.8.0")).values
        del values["MONGO_IMAGE"]
        again = _build(existing=values, mongo=cfg.choose_mongo(True, "6.8.0"))
        self.assertNotIn("MONGO_IMAGE", again.values)
        self.assertTrue(any("mongo-upgrade" in n for n in again.notes))

    def test_not_asked_writes_nothing(self):
        self.assertNotIn("MONGO_IMAGE", _build().values)


class Check(unittest.TestCase):
    def report(self, image, avx, release, profiles="gateway,chat"):
        values = {"COMPOSE_PROFILES": profiles}
        if image:
            values["MONGO_IMAGE"] = image
        report = cfg.Report()
        cfg.check_mongo(values, report, avx, release)
        return report

    def test_mongo8_without_avx_is_an_error(self):
        r = self.report("mongo:8.0.34", False, "6.8.0")
        self.assertEqual(len(r.errors), 1)
        self.assertIn("AVX", r.errors[0])

    def test_mongo8_on_affected_kernel_is_an_error(self):
        r = self.report("mongo:8.0.34", True, "7.0.0-38-generic")
        self.assertEqual(len(r.errors), 1)
        self.assertIn("7.0.0-38-generic", r.errors[0])

    def test_mongo5_without_avx_is_an_error_but_4_4_is_fine(self):
        self.assertTrue(self.report("mongo:5.0.33", False, "6.8.0").errors)
        self.assertFalse(self.report("mongo:4.4.30", False, "6.8.0").errors)
        self.assertFalse(self.report(None, False, "7.0.0").errors)  # compose's default

    def test_mongo7_is_fine_on_the_affected_kernel(self):
        self.assertFalse(self.report("mongo:7.0.45", True, "7.0.0").errors)

    def test_unknown_host_is_not_an_error(self):
        self.assertFalse(self.report("mongo:8.0.34", None, "weird").errors)

    def test_other_images_are_noted_not_checked(self):
        r = self.report("registry.example/mongo:8", False, "6.8.0")
        self.assertFalse(r.errors)
        self.assertTrue(r.notes)

    def test_no_chat_profile_no_check(self):
        self.assertFalse(self.report("mongo:8.0.34", False, "6.8.0", profiles="gateway").errors)

    def test_4_4_on_a_capable_host_suggests_the_upgrade(self):
        r = self.report("mongo:4.4.30", True, "6.8.0")
        self.assertTrue(any("mongo-upgrade" in n for n in r.notes))
        r = self.report("mongo:4.4.30", False, "6.8.0")
        self.assertFalse(any("mongo-upgrade" in n for n in r.notes))


# --- tools/mongo-upgrade ------------------------------------------------------------


class FakeDocker:
    """Answers the commands tools/mongo-upgrade issues, and records them."""

    def __init__(self, fcv="4.4", fail_on=None):
        self.calls = []
        self.fcv = fcv
        self.fail_on = fail_on  # (series_or_command, ...) substring that makes a call fail
        self.running = False
        self.image = None
        self.dump = b"archive"

    def __call__(self, argv, timeout=600, cwd=None, stdout_path=None):
        argv = list(argv)
        line = " ".join(argv)
        self.calls.append(line)
        if self.fail_on and self.fail_on in line:
            return 1, f"boom: {self.fail_on}"
        if argv[:3] == ["docker", "compose", "exec"] and "mongodump" in argv:
            Path(stdout_path).write_bytes(self.dump)
            return 0, ""
        if argv[:2] == ["docker", "run"]:
            self.running, self.image = True, argv[argv.index("--bind_ip") - 1]
            return 0, "cid"
        if argv[:2] == ["docker", "inspect"]:
            return 0, ("true" if self.running else "false") if "Running" in line else "0"
        if argv[:2] == ["docker", "stop"]:
            self.running = False
            return 0, ""
        if argv[:2] == ["docker", "exec"]:
            expr = argv[-1]
            if "ping" in expr:
                return 0, "1\n"
            if "getParameter" in expr:
                return 0, json.dumps({"version": self.fcv}) + "\n"
            m = re.search(r'setFeatureCompatibilityVersion: "([\d.]+)"', expr)
            if m:
                self.fcv = m.group(1)
                return 0, '{"ok":1}\n'
        if argv[:3] == ["docker", "compose", "ps"]:
            return 0, "chat-mongo\nchat\n"
        if len(argv) > 2 and argv[1].endswith("configure") and "--set" in argv:
            Path(cwd, ".env").write_text(
                re.sub(r"MONGO_IMAGE='[^']*'", "", Path(cwd, ".env").read_text())
                + f"MONGO_IMAGE='{argv[-1].split('=', 1)[1]}'\n"
            )
            return 0, ""
        return 0, ""


class UpgradeTool(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="mongo-upgrade-test-"))
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        (self.dir / ".env").write_text(
            "COMPOSE_PROJECT_NAME='cerea'\nCOMPOSE_PROFILES='gateway,chat'\n"
            f"MONGO_IMAGE='{cfg.MONGO_FALLBACK}'\n"
        )

    def tool(self, docker):
        return up.Upgrade(self.dir, docker, say=lambda *a: None, sleep=lambda s: None)

    def steps(self, series=(4, 4), target="8.0"):
        return up.plan(series, target)

    def test_plan_from_4_4_is_the_whole_path(self):
        self.assertEqual([s[0] for s in self.steps()], ["5.0", "6.0", "7.0", "8.0"])
        self.assertEqual([s[0] for s in self.steps(target="7.0")], ["5.0", "6.0", "7.0"])

    def test_plan_resumes_from_the_current_series(self):
        self.assertEqual([s[0] for s in self.steps((6, 0))], ["7.0", "8.0"])
        self.assertEqual(self.steps((8, 0)), [])
        self.assertEqual(self.steps((7, 0), "5.0"), [])

    def test_plan_refuses_what_it_cannot_start_from(self):
        for series in ((4, 2), (3, 6), (4, 3), (5, 3)):
            with self.assertRaises(up.Refused, msg=str(series)):
                self.steps(series)

    def test_current_series_prefers_the_state_file(self):
        self.assertEqual(up.current_series({"MONGO_IMAGE": "mongo:4.4.30"}, {}), (4, 4))
        self.assertEqual(up.current_series({"MONGO_IMAGE": "mongo:4.4.30"}, {"completed": ["5.0", "6.0"]}), (6, 0))
        self.assertEqual(up.current_series({}, {}), (4, 4))  # no key: compose's default
        with self.assertRaises(up.Refused):
            up.current_series({"MONGO_IMAGE": "registry.example/mongo:4.4"}, {})

    def test_refuses_without_avx(self):
        with self.assertRaises(up.Refused) as ctx:
            up.preflight(False, "6.8.0", "8.0")
        self.assertIn("no AVX", str(ctx.exception))

    def test_refuses_when_avx_is_unknown(self):
        with self.assertRaises(up.Refused):
            up.preflight(None, "6.8.0", "8.0")

    def test_refuses_8_on_an_affected_kernel_but_allows_7(self):
        with self.assertRaises(up.Refused) as ctx:
            up.preflight(True, "7.0.0-38-generic", "8.0")
        self.assertIn("--target 7.0", str(ctx.exception))
        up.preflight(True, "7.0.0-38-generic", "7.0")
        up.preflight(True, "7.0.14-1-generic", "8.0")

    def test_main_refuses_on_no_avx_and_touches_no_container(self):
        docker = FakeDocker()
        err = io.StringIO()
        with mock.patch.object(up.cfg, "detect_host", return_value=(False, "6.8.0")), redirect_stderr(err):
            rc = up.main(["--dir", str(self.dir), "--yes"], runner=docker)
        self.assertEqual(rc, 2)
        self.assertIn("no AVX", err.getvalue())
        self.assertEqual(docker.calls, [])
        self.assertFalse((self.dir / up.STATE_NAME).exists())

    def run_main(self, docker, *argv):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(up.cfg, "detect_host", return_value=(True, "6.8.0-1-generic")), \
             redirect_stdout(out), redirect_stderr(err):
            rc = up.main(["--dir", str(self.dir), "--yes", *argv], runner=docker)
        return rc, out.getvalue(), err.getvalue()

    def test_plan_only_changes_nothing(self):
        docker = FakeDocker()
        rc, out, _ = self.run_main(docker, "--plan")
        self.assertEqual(rc, 0)
        self.assertIn("5.0 -> 6.0 -> 7.0 -> 8.0", out)
        self.assertEqual(docker.calls, [])

    def test_full_run_order_fcv_and_env(self):
        docker = FakeDocker()
        rc, out, err = self.run_main(docker)
        self.assertEqual(rc, 0, err)
        runs = [c for c in docker.calls if c.startswith("docker run")]
        self.assertEqual(
            [re.search(r"(mongo:\S+) --bind_ip", c).group(1) for c in runs],
            [s[1] for s in up.STEPS],
        )
        for c in runs:  # alone on the volume: no network, no published port
            self.assertIn("--network none", c)
            self.assertNotIn(" -p ", c)
            self.assertIn("cerea_chat-mongo-data:/data/db", c)
        self.assertEqual(docker.fcv, "8.0")
        # backup first (chat stopped, mongodump), before any step image runs
        first_run = next(i for i, c in enumerate(docker.calls) if c.startswith("docker run"))
        dump = next(i for i, c in enumerate(docker.calls) if "mongodump" in c)
        stop_chat = next(i for i, c in enumerate(docker.calls) if c.startswith("docker compose stop") and "chat" in c)
        self.assertLess(stop_chat, dump)
        self.assertLess(dump, first_run)
        # confirm: true on 7.0 and 8.0 only
        sets = [c for c in docker.calls if "setFeatureCompatibilityVersion" in c]
        self.assertEqual(len(sets), 4)
        self.assertEqual(["confirm: true" in c for c in sets], [False, False, True, True])
        self.assertIn(f"MONGO_IMAGE='{cfg.MONGO_DEFAULT}'", (self.dir / ".env").read_text())
        self.assertFalse((self.dir / up.STATE_NAME).exists())
        backups = list(self.dir.glob("mongo-upgrade-backup-*.archive.gz"))
        self.assertEqual(len(backups), 1)
        self.assertIn("docker compose up -d --wait", out)
        self.assertFalse([c for c in docker.calls if "compose up" in c and "chat-mongo" not in c])  # starts nothing else

    def test_step_failure_leaves_a_resumable_state(self):
        docker = FakeDocker(fail_on="setFeatureCompatibilityVersion: \"7.0\"")
        rc, _, err = self.run_main(docker)
        self.assertEqual(rc, 1)
        self.assertIn("FAILED", err)
        self.assertIn("resumes", err)
        state = json.loads((self.dir / up.STATE_NAME).read_text())
        self.assertEqual(state["completed"], ["5.0", "6.0"])
        # .env names the version the data is at, so the stack would still start
        self.assertIn("MONGO_IMAGE='mongo:6.0.28'", (self.dir / ".env").read_text())
        self.assertNotIn("mongo-upgrade-test-container", " ".join(docker.calls))
        self.assertTrue([c for c in docker.calls if c.startswith("docker rm -f")])  # no stray container

        # Re-run: no second backup, no 5.0 or 6.0 again, 7.0 then 8.0.
        docker2 = FakeDocker(fcv="6.0")
        rc, out, err = self.run_main(docker2)
        self.assertEqual(rc, 0, err)
        self.assertIn("resuming", out)
        self.assertFalse([c for c in docker2.calls if "mongodump" in c])
        runs = [re.search(r"(mongo:\S+) --bind_ip", c).group(1) for c in docker2.calls if c.startswith("docker run")]
        self.assertEqual(runs, [up.STEPS[2][1], up.STEPS[3][1]])
        self.assertIn(f"MONGO_IMAGE='{cfg.MONGO_DEFAULT}'", (self.dir / ".env").read_text())

    def test_a_step_whose_fcv_is_already_set_is_not_set_again(self):
        # The previous run set the FCV, then died before recording the step.
        docker = FakeDocker(fcv="5.0")
        tool = self.tool(docker)
        tool.step("5.0", "mongo:5.0.33", False)
        self.assertFalse([c for c in docker.calls if "setFeatureCompatibilityVersion" in c])

    def test_a_pending_transition_is_not_accepted_as_done(self):
        docker = FakeDocker(fcv="5.0")
        orig = docker.__call__

        def read_with_target(argv, **kw):
            rc, out = orig(argv, **kw)
            if "getParameter" in argv[-1]:
                return rc, json.dumps({"version": "4.4", "targetVersion": "5.0"}) + "\n"
            return rc, out

        with self.assertRaises(up.StepFailed):
            self.tool(read_with_target).step("5.0", "mongo:5.0.33", False)

    def test_failed_dump_stops_before_any_step(self):
        docker = FakeDocker(fail_on="mongodump")
        rc, _, err = self.run_main(docker)
        self.assertEqual(rc, 1)
        self.assertFalse([c for c in docker.calls if c.startswith("docker run")])
        self.assertEqual(list(self.dir.glob("mongo-upgrade-backup-*")), [])
        self.assertIn("nothing was changed", err)

    def test_sidecar_backup_is_taken_when_it_runs(self):
        docker = FakeDocker()
        original = docker.__call__

        def with_sidecar(argv, **kw):
            if list(argv)[:3] == ["docker", "compose", "ps"]:
                docker.calls.append(" ".join(argv))
                return 0, "chat-mongo\nbackup\n"
            return original(argv, **kw)

        rc, _, _ = self.run_main(with_sidecar)
        self.assertEqual(rc, 0)
        self.assertTrue([c for c in docker.calls if "backup-now" in c])

    def test_container_that_dies_reports_its_log(self):
        docker = FakeDocker()
        orig = docker.__call__

        def dies(argv, **kw):
            if list(argv)[:2] == ["docker", "inspect"] and "Running" in " ".join(argv):
                docker.calls.append(" ".join(argv))
                return 0, "false"
            if list(argv)[:2] == ["docker", "logs"]:
                return 0, "Illegal instruction"
            return orig(argv, **kw)

        with self.assertRaises(up.StepFailed) as ctx:
            self.tool(dies).step("5.0", "mongo:5.0.33", False)
        self.assertIn("Illegal instruction", str(ctx.exception))

    def test_dump_file_is_private(self):
        path = self.dir / "dump"
        rc, _ = up.run(["sh", "-c", "echo data"], stdout_path=path, cwd=self.dir)
        self.assertEqual(rc, 0)
        self.assertEqual(path.read_text(), "data\n")
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_non_terminal_without_yes_refuses(self):
        docker = FakeDocker()
        err = io.StringIO()
        with mock.patch.object(up.cfg, "detect_host", return_value=(True, "6.8.0")), \
             mock.patch.object(sys, "stdin", io.StringIO("")), redirect_stderr(err):
            rc = up.main(["--dir", str(self.dir)], runner=docker)
        self.assertEqual(rc, 2)
        self.assertEqual(docker.calls, [])

    def test_already_at_target_is_a_no_op(self):
        (self.dir / ".env").write_text(
            f"COMPOSE_PROFILES='chat'\nMONGO_IMAGE='{cfg.MONGO_DEFAULT}'\n"
        )
        docker = FakeDocker()
        rc, out, _ = self.run_main(docker)
        self.assertEqual(rc, 0)
        self.assertIn("nothing to do", out)
        self.assertEqual(docker.calls, [])


if __name__ == "__main__":
    unittest.main()
