"""Server sandboxes (ADR 0115): the SANDBOX switch in ./configure, and the kit's static rules.

One switch (off, local, remote) sets the profile, the URL and the token together; a mix is an
error, never a half-on feature. The compose rules are static checks, like test_fetch_box.py:
the Docker socket is mounted by the proxy alone, the manager is never published in the kit's
compose, every service has resource limits. Standard library only.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_configure import Deploy, build, cfg  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
COMPOSE = (ROOT / "compose.yaml").read_text(encoding="utf-8")
STANDALONE = (ROOT / "sandbox" / "compose.yaml").read_text(encoding="utf-8")
EXAMPLE = (ROOT / ".env.example").read_text(encoding="utf-8")
STANDALONE_EXAMPLE = (ROOT / "sandbox" / ".env.example").read_text(encoding="utf-8")


def service(text: str, name: str) -> str:
    match = re.search(rf"^  {re.escape(name)}:\n((?:(?!^  \S|^\S).*\n|\n)*)", text, re.MULTILINE)
    assert match, f"no service {name}"
    return match.group(1)


def profiles(values: dict) -> list:
    return [p for p in values["COMPOSE_PROFILES"].split(",") if p]


def check(values: dict) -> cfg.Report:
    report = cfg.Report()
    cfg.check_values(values, report)
    return report


def sandbox_errors(values: dict) -> list:
    return [e for e in check(values).errors if "SANDBOX" in e]


class Switch(unittest.TestCase):
    def test_it_is_off_by_default_and_check_is_quiet(self):
        values = build().values
        self.assertEqual(values["SANDBOX"], "off")
        self.assertNotIn("sandbox", profiles(values))
        self.assertEqual(values.get("SANDBOX_MANAGER_URL", ""), "")
        self.assertEqual(values.get("SANDBOX_MANAGER_TOKEN", ""), "")
        self.assertEqual(sandbox_errors(values), [])

    def test_local_adds_the_profile_the_in_compose_url_and_a_token(self):
        values = build(sandbox="local").values
        self.assertIn("sandbox", profiles(values))
        self.assertEqual(values["SANDBOX_MANAGER_URL"], cfg.SANDBOX_ENDPOINT)
        self.assertGreaterEqual(len(values["SANDBOX_MANAGER_TOKEN"]), 32)
        self.assertEqual(sandbox_errors(values), [])

    def test_local_keeps_its_token_on_a_rerun(self):
        first = dict(build(sandbox="local").values)
        again = build(existing=first, sandbox="local").values
        self.assertEqual(again["SANDBOX_MANAGER_TOKEN"], first["SANDBOX_MANAGER_TOKEN"])
        self.assertEqual(build(existing=first).values["SANDBOX"], "local")

    def test_off_removes_the_profile_the_url_and_the_token(self):
        on = dict(build(sandbox="local").values)
        off = build(existing=on, sandbox="off").values
        self.assertEqual(off["SANDBOX"], "off")
        self.assertNotIn("sandbox", profiles(off))
        self.assertEqual((off["SANDBOX_MANAGER_URL"], off["SANDBOX_MANAGER_TOKEN"]), ("", ""))
        self.assertEqual(sandbox_errors(off), [])

    def test_remote_takes_a_url_and_a_token_and_runs_nothing_here(self):
        token = "t" * 40
        values = build(sandbox="remote", sandbox_url="https://sandbox.example.org", sandbox_token=token).values
        self.assertNotIn("sandbox", profiles(values))
        self.assertEqual(values["SANDBOX_MANAGER_URL"], "https://sandbox.example.org")
        self.assertEqual(values["SANDBOX_MANAGER_TOKEN"], token)
        self.assertEqual(sandbox_errors(values), [])

    def test_remote_without_a_url_or_token_is_refused(self):
        with self.assertRaises(cfg.ConfigError):
            build(sandbox="remote", sandbox_token="t" * 40)
        with self.assertRaises(cfg.ConfigError):
            build(sandbox="remote", sandbox_url="https://sandbox.example.org")
        with self.assertRaises(cfg.ConfigError):
            build(sandbox="remote", sandbox_url="ftp://x", sandbox_token="t" * 40)

    def test_local_to_remote_does_not_reuse_the_in_compose_url_or_token(self):
        local = dict(build(sandbox="local").values)
        with self.assertRaises(cfg.ConfigError):
            build(existing=local, sandbox="remote")
        with self.assertRaises(cfg.ConfigError):
            build(existing=local, sandbox="remote", sandbox_url="https://sandbox.example.org")
        moved = build(existing=local, sandbox="remote", sandbox_url="https://sandbox.example.org", sandbox_token="r" * 32).values
        self.assertNotIn("sandbox", profiles(moved))
        self.assertEqual(moved["SANDBOX_MANAGER_TOKEN"], "r" * 32)

    def test_remote_over_plain_http_is_noted(self):
        result = build(sandbox="remote", sandbox_url="http://10.0.0.5:8080", sandbox_token="t" * 40)
        self.assertTrue(any("plain http" in n for n in result.notes), result.notes)

    def test_an_unknown_mode_is_refused(self):
        with self.assertRaises(cfg.ConfigError):
            build(sandbox="maybe")

    def test_the_other_profiles_are_untouched(self):
        plain = profiles(build().values)
        self.assertEqual([p for p in profiles(build(sandbox="local").values) if p != "sandbox"], plain)


class CodeExecution(unittest.TestCase):
    """--code-execution: where execute_code runs; `server` needs the sandbox switch on."""

    def test_server_needs_sandboxes(self):
        with self.assertRaises(cfg.ConfigError):
            build(code_execution="server")
        values = build(sandbox="local", code_execution="server").values
        self.assertEqual(values["CHAT_CODE_EXECUTION"], "server")
        self.assertEqual(sandbox_errors(values), [])

    def test_browser_is_the_empty_default_and_off_is_kept(self):
        self.assertEqual(build(code_execution="browser").values.get("CHAT_CODE_EXECUTION", ""), "")
        self.assertEqual(build(code_execution="off").values["CHAT_CODE_EXECUTION"], "off")
        with self.assertRaises(cfg.ConfigError):
            build(code_execution="maybe")

    def test_turning_sandboxes_off_leaves_the_setting_but_says_it_cannot_work(self):
        on = dict(build(sandbox="local", code_execution="server").values)
        result = build(existing=on, sandbox="off")
        self.assertEqual(result.values["CHAT_CODE_EXECUTION"], "server")
        self.assertTrue(any("execute_code runs in the browser" in n for n in result.notes), result.notes)
        report = check(result.values)
        self.assertTrue(any("CHAT_CODE_EXECUTION=server" in w for w in report.warnings), report.warnings)


class Mismatch(unittest.TestCase):
    """A mix is an error from ./configure --check, never silently half-on."""

    def test_each_mix_is_reported(self):
        local = dict(build(sandbox="local").values)
        off = dict(build().values)
        remote = dict(build(sandbox="remote", sandbox_url="https://s.example.org", sandbox_token="t" * 32).values)
        cases = {
            "local, profile missing": local | {"COMPOSE_PROFILES": off["COMPOSE_PROFILES"]},
            "local, no token": local | {"SANDBOX_MANAGER_TOKEN": ""},
            "local, wrong url": local | {"SANDBOX_MANAGER_URL": "https://elsewhere.example.org"},
            "off, profile on": off | {"COMPOSE_PROFILES": local["COMPOSE_PROFILES"]},
            "off, url set": off | {"SANDBOX_MANAGER_URL": "http://x:8080"},
            "off, token set": off | {"SANDBOX_MANAGER_TOKEN": "t" * 32},
            "remote, profile on": remote | {"COMPOSE_PROFILES": local["COMPOSE_PROFILES"]},
            "remote, no url": remote | {"SANDBOX_MANAGER_URL": ""},
            "remote, the in-compose url": remote | {"SANDBOX_MANAGER_URL": cfg.SANDBOX_ENDPOINT},
            "remote, no token": remote | {"SANDBOX_MANAGER_TOKEN": ""},
            "unknown mode": off | {"SANDBOX": "yes"},
        }
        for name, values in cases.items():
            self.assertTrue(sandbox_errors(values), name)
        self.assertEqual(sandbox_errors(local), [])
        self.assertEqual(sandbox_errors(remote), [])


class Runtime(Deploy):
    def test_local_needs_runsc_registered_or_it_stays_off(self):
        with mock.patch.object(cfg, "docker_runtimes", return_value={"runc", "io.containerd.runc.v2"}):
            code, _, err = self.run_cli(
                "--non-interactive", "--origin", "https://chat.example.org", "--admin-email", "a@example.org",
                "--sandbox", "local",
            )
        self.assertEqual(code, 0, err)
        self.assertIn("runsc", err)
        self.assertIn("leaving server sandboxes off", err)
        values = self.env()
        self.assertEqual(values["SANDBOX"], "off")
        self.assertNotIn("sandbox", values["COMPOSE_PROFILES"].split(","))

    def test_local_goes_ahead_with_runsc(self):
        with mock.patch.object(cfg, "docker_runtimes", return_value={"runc", "runsc"}):
            code, out, err = self.run_cli(
                "--non-interactive", "--origin", "https://chat.example.org", "--admin-email", "a@example.org",
                "--sandbox", "local",
            )
        self.assertEqual(code, 0, err)
        values = self.env()
        self.assertEqual(values["SANDBOX"], "local")
        self.assertIn("sandbox", values["COMPOSE_PROFILES"].split(","))
        self.assertIn("sandbox", out)

    def test_runc_counts_only_when_explicitly_allowed(self):
        with mock.patch.object(cfg, "docker_runtimes", return_value={"runc"}):
            self.assertIsNotNone(cfg.sandbox_runtime_problem({}))
            self.assertIsNone(cfg.sandbox_runtime_problem({"SANDBOX_RUNTIME": "runc", "SANDBOX_ALLOW_RUNC": "true"}))
            self.assertIsNotNone(cfg.sandbox_runtime_problem({"SANDBOX_RUNTIME": "runc"}))

    def test_an_unaskable_docker_is_a_problem_not_a_guess(self):
        with mock.patch.object(cfg, "docker_runtimes", return_value=None):
            self.assertIn("cannot ask Docker", cfg.sandbox_runtime_problem({}))

    def test_remote_reads_the_token_from_the_environment(self):
        with mock.patch.dict("os.environ", {"SBX_TOKEN": "x" * 40}):
            code, _, err = self.run_cli(
                "--non-interactive", "--origin", "https://chat.example.org", "--admin-email", "a@example.org",
                "--sandbox", "remote", "--sandbox-url", "https://sandbox.example.org", "--sandbox-token-env", "SBX_TOKEN",
            )
        self.assertEqual(code, 0, err)
        values = self.env()
        self.assertEqual(values["SANDBOX"], "remote")
        self.assertEqual(values["SANDBOX_MANAGER_TOKEN"], "x" * 40)
        self.assertNotIn("sandbox", values["COMPOSE_PROFILES"].split(","))


class ComposeRules(unittest.TestCase):
    def test_the_socket_is_mounted_by_the_proxy_alone(self):
        for text in (COMPOSE, STANDALONE):
            self.assertIn("docker.sock", service(text, "sandbox-socket-proxy"))
            self.assertNotIn("docker.sock", service(text, "sandbox-manager"))
        self.assertNotIn("docker.sock", service(COMPOSE, "chat"))
        self.assertEqual(COMPOSE.count("docker.sock"), service(COMPOSE, "sandbox-socket-proxy").count("docker.sock"))

    def test_the_services_are_off_unless_the_profile_is_on(self):
        for name in ("sandbox-socket-proxy", "sandbox-manager"):
            self.assertIn("profiles: [sandbox]", service(COMPOSE, name))

    def test_the_networks(self):
        self.assertEqual(re.search(r"networks: \[(.*)\]", service(COMPOSE, "sandbox-socket-proxy")).group(1), "sandbox-docker")
        self.assertEqual(
            re.search(r"networks: \[(.*)\]", service(COMPOSE, "sandbox-manager")).group(1), "sandbox-docker, sandbox-api"
        )
        for net in ("sandbox-docker", "sandbox-api"):
            block = re.search(rf"^  {net}:\n((?:    .*\n)*)", COMPOSE, re.MULTILINE).group(1)
            self.assertIn("internal: true", block)
        self.assertIn("sandbox-api", re.search(r"networks: \[default.*\]", service(COMPOSE, "chat")).group(0))

    def test_the_kit_publishes_no_port_and_the_standalone_one_binds_to_loopback_by_default(self):
        self.assertNotIn("ports:", service(COMPOSE, "sandbox-manager"))
        self.assertNotIn("ports:", service(COMPOSE, "sandbox-socket-proxy"))
        self.assertNotIn("ports:", service(STANDALONE, "sandbox-socket-proxy"))
        self.assertIn("${SANDBOX_BIND:-127.0.0.1}", service(STANDALONE, "sandbox-manager"))

    def test_every_service_is_boxed_and_limited(self):
        for text in (COMPOSE, STANDALONE):
            for name in ("sandbox-socket-proxy", "sandbox-manager"):
                block = service(text, name)
                for want in ("read_only: true", "cap_drop: [ALL]", "no-new-privileges:true", "mem_limit:", "cpus:", "pids_limit:"):
                    self.assertIn(want, block, f"{name}: {want}")

    def test_the_manager_and_the_proxy_agree_on_the_image_and_runtime(self):
        for text in (COMPOSE, STANDALONE):
            self.assertIn("SANDBOX_ALLOWED_IMAGES: *sandbox-exec-image", service(text, "sandbox-socket-proxy"))
            self.assertIn("SANDBOX_EXEC_IMAGE: *sandbox-exec-image", service(text, "sandbox-manager"))
            self.assertIn("cerea-sandbox-python:${CEREA_VERSION:-", text, "the sandbox image is the versioned Python image")
            for name in ("sandbox-socket-proxy", "sandbox-manager"):
                self.assertIn("SANDBOX_RUNTIME: ${SANDBOX_RUNTIME:-runsc}", service(text, name))

    def test_the_chat_gets_the_switch_the_url_and_the_token(self):
        chat = service(COMPOSE, "chat")
        for want in ("SANDBOX: ${SANDBOX:-off}", "SANDBOX_MANAGER_URL:", "SANDBOX_MANAGER_TOKEN:"):
            self.assertIn(want, chat)

    def test_every_variable_the_services_read_is_in_the_examples(self):
        for text, example in ((COMPOSE, EXAMPLE), (STANDALONE, STANDALONE_EXAMPLE)):
            for name in ("sandbox-socket-proxy", "sandbox-manager"):
                for var in re.findall(r"\$\{(SANDBOX_[A-Z_]+)[:-]", service(text, name)):
                    if var in ("SANDBOX_IMAGE", "SANDBOX_PULL_POLICY"):
                        continue
                    self.assertRegex(example, rf"(?m)^{var}=", f"{var} is not in the example")

    def test_the_runtime_and_the_machines_switch_default_safely(self):
        self.assertRegex(EXAMPLE, r"(?m)^SANDBOX='off'$")
        self.assertRegex(EXAMPLE, r"(?m)^SANDBOX_MACHINES_ENABLED=''$")
        self.assertRegex(EXAMPLE, r"(?m)^SANDBOX_ALLOW_RUNC=''$")

    def test_the_exec_image_is_built_from_a_digest_pinned_base(self):
        dockerfile = (ROOT.parent / "sandbox" / "exec-image" / "Dockerfile").read_text(encoding="utf-8")
        self.assertRegex(dockerfile, r"(?m)^FROM python:3\.13-slim@sha256:[0-9a-f]{64}$")
        requirements = (ROOT.parent / "sandbox" / "exec-image" / "requirements.txt").read_text(encoding="utf-8")
        lines = [l for l in requirements.splitlines() if l.strip()]
        self.assertTrue(lines and all("==" in l for l in lines), "every package is pinned to a version")
        for want in ("numpy", "pandas", "matplotlib", "scipy", "pillow", "openpyxl", "python-docx", "python-pptx"):
            self.assertTrue(any(l.lower().startswith(want + "==") for l in lines), want)

    def test_the_exec_image_is_published_and_checked_with_the_others(self):
        images = (ROOT.parent / ".github" / "workflows" / "images.yml").read_text(encoding="utf-8")
        self.assertIn("images: ghcr.io/${{ github.repository_owner }}/cerea-sandbox-python", images)
        self.assertIn("context: sandbox/exec-image", images)
        release = (ROOT.parent / "scripts" / "release" / "release.sh").read_text(encoding="utf-8")
        self.assertIn("cerea-sandbox-python", release)


if __name__ == "__main__":
    unittest.main()
