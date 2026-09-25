"""./configure's rules, as unit tests. Standard library only: `python3 -m unittest`."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent


def _load():
    loader = importlib.machinery.SourceFileLoader("configure", str(ROOT / "configure"))
    spec = importlib.util.spec_from_loader("configure", loader)
    module = importlib.util.module_from_spec(spec)
    sys.modules["configure"] = module
    loader.exec_module(module)
    return module


cfg = _load()
TEMPLATE = (ROOT / ".env.example").read_text(encoding="utf-8")


def answers(**kw):
    base = dict(origin="https://chat.example.org", admin_email="ops@example.org")
    base.update(kw)
    return cfg.Answers(**base)


def build(existing=None, **kw):
    return cfg.build(answers(**kw), existing or {}, TEMPLATE)


class Deploy(unittest.TestCase):
    """A scratch copy of the repository files ./configure reads."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="configure-test-"))
        for name in (".env.example", "compose.yaml"):
            shutil.copy(ROOT / name, self.dir / name)
        for name in ("caddy", "authelia", "proxy.d"):
            shutil.copytree(ROOT / name, self.dir / name)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cfg.main(["--dir", str(self.dir), *argv])
        return code, out.getvalue(), err.getvalue()

    def env(self):
        return cfg.parse_env((self.dir / ".env").read_text(encoding="utf-8"))


class TestEnvFiles(unittest.TestCase):
    def test_parse_follows_compose_quoting(self):
        values = cfg.parse_env(
            "A='x $y #z'\nB=\"a\\tb\"\nC=plain # comment\nexport D=1\n# E='no'\n\nF=''\n"
        )
        self.assertEqual(values, {"A": "x $y #z", "B": "a\tb", "C": "plain", "D": "1", "F": ""})

    def test_parse_refuses_garbage(self):
        with self.assertRaises(cfg.ConfigError):
            cfg.parse_env("not a line\n")

    def test_quote_refuses_what_compose_cannot_hold(self):
        with self.assertRaises(cfg.ConfigError):
            cfg.quote("K", "it's")

    def test_render_keeps_the_template_layout_and_unknown_keys(self):
        values = cfg.template_defaults(TEMPLATE)
        values["PYSTINO_REGISTRY"] = "local"  # commented out in the template
        values["MY_OWN"] = "kept"
        text = cfg.render(TEMPLATE, values, cfg.HEADER)
        self.assertIn("PYSTINO_REGISTRY='local'", text)
        self.assertIn("# CEREA_REGISTRY='local'", text)  # still a comment
        self.assertIn("# --- Database", text)
        self.assertTrue(text.rstrip().endswith("MY_OWN='kept'"))
        self.assertEqual(cfg.parse_env(text), values)

    def test_every_template_value_is_single_quoted(self):
        active, _ = cfg.template_keys(TEMPLATE)
        for line in TEMPLATE.splitlines():
            if cfg._ACTIVE.match(line):
                self.assertRegex(line, r"^[A-Z0-9_]+='[^']*'$")
        self.assertEqual(len(active), len(set(active)), "a key appears twice in .env.example")


class TestDigests(unittest.TestCase):
    def test_pbkdf2_round_trip(self):
        digest = cfg.pbkdf2_digest("s3cret", rounds=1000)
        self.assertTrue(digest.startswith("$pbkdf2-sha512$1000$"))
        self.assertIs(cfg.digest_matches("s3cret", digest), True)
        self.assertIs(cfg.digest_matches("other", digest), False)

    def test_known_vector(self):
        # Salt and output fixed: the format Authelia's `crypto hash validate`
        # accepted when this was written (checked against authelia 4.39.22).
        digest = cfg.pbkdf2_digest("password", rounds=1000, salt=b"\x00" * 16)
        self.assertEqual(digest.split("$")[3], "AAAAAAAAAAAAAAAAAAAAAA")
        self.assertNotIn("+", digest)
        self.assertNotIn("=", digest)

    def test_argon2_digests_are_left_alone(self):
        self.assertIsNone(cfg.digest_matches("x", "$argon2id$v=19$m=65536,t=3,p=4$abc$def"))


class TestRefusals(unittest.TestCase):
    def test_http_origin(self):
        with self.assertRaisesRegex(cfg.ConfigError, "https"):
            build(origin="http://chat.example.org")

    def test_origin_with_a_path(self):
        with self.assertRaises(cfg.ConfigError):
            build(origin="https://example.org/chat")

    def test_acme_on_an_ip(self):
        with self.assertRaisesRegex(cfg.ConfigError, "acme"):
            build(origin="https://10.0.0.5", tls="acme", idp="external")

    def test_acme_on_a_dotless_host(self):
        with self.assertRaisesRegex(cfg.ConfigError, "acme"):
            build(origin="https://chatbox", tls="acme")

    def test_authelia_on_an_ip(self):
        with self.assertRaisesRegex(cfg.ConfigError, "dotted"):
            build(origin="https://10.0.0.5", tls="internal")

    def test_admin_email_must_have_a_domain(self):
        with self.assertRaisesRegex(cfg.ConfigError, "email"):
            build(admin_email="admin@local")

    def test_external_idp_needs_its_secrets(self):
        with self.assertRaisesRegex(cfg.ConfigError, "issuer"):
            build(idp="external")
        with self.assertRaisesRegex(cfg.ConfigError, "console"):
            build(idp="external", oidc_issuer="https://id.example.org")

    def test_generic_needs_a_key_and_satellite_refuses_one(self):
        with self.assertRaisesRegex(cfg.ConfigError, "API key"):
            build(preset="generic", idp="external", oidc_issuer="https://id.example.org",
                  oidc_chat_client_secret="c")
        with self.assertRaisesRegex(cfg.ConfigError, "no API key"):
            build(preset="satellite", central_url="https://central.example.org",
                  upstream_api_key="k", oidc_chat_client_secret="c")


class TestFreshInstall(unittest.TestCase):
    def test_every_preset_satisfies_its_own_check(self):
        extra = {
            "satellite": dict(central_url="https://central.example.org", oidc_chat_client_secret="c"),
            "generic": dict(idp="external", oidc_issuer="https://id.example.org",
                            oidc_chat_client_secret="c", upstream_api_key="k"),
        }
        for name in cfg.PRESETS:
            with self.subTest(preset=name):
                result = build(preset=name, **extra.get(name, {}))
                report = cfg.Report()
                values = dict(result.values)
                if name == "enterprise":
                    values["REDACTION_IMAGE"] = "local/pystino-redaction:sha-x-ner"
                cfg.check_values(values, report)
                self.assertEqual(report.errors, [], name)
                profiles = values["COMPOSE_PROFILES"].split(",")
                self.assertEqual(values["PROXY_DEFAULT"], "chat" if "gateway" not in profiles else "gateway")

    def test_bundled_authelia(self):
        result = build(tls="internal", origin="https://chat.example.org:8443")
        v = result.values
        self.assertEqual(v["COMPOSE_PROFILES"], "gateway,chat,authelia,redaction")
        self.assertEqual(v["OIDC_ISSUER"], "https://chat.example.org:8443/authelia")
        self.assertEqual(v["OIDC_INTERNAL_BASE_URL"], cfg.AUTHELIA_INTERNAL)
        self.assertEqual(v["OIDC_KIND"], "authelia")
        self.assertEqual(v["AUTHELIA_COOKIE_DOMAIN"], "chat.example.org")
        self.assertEqual(v["SITE_ADDRESS"], "https://chat.example.org")
        self.assertEqual(v["TLS_DIRECTIVE"], "tls internal")
        self.assertEqual(v["HTTPS_PORT"], "8443")
        self.assertIs(cfg.digest_matches(v["OIDC_CONSOLE_CLIENT_SECRET"], v["AUTHELIA_CONSOLE_CLIENT_DIGEST"]), True)
        self.assertIs(cfg.digest_matches(v["OIDC_CHAT_CLIENT_SECRET"], v["AUTHELIA_CHAT_CLIENT_DIGEST"]), True)
        self.assertIs(cfg.digest_matches(result.admin_password, v["AUTHELIA_ADMIN_PASSWORD_DIGEST"]), True)
        for key in (*cfg.MINTED, *cfg.MINTED_AUTHELIA):
            self.assertGreaterEqual(len(v[key]), 48, key)

    def test_upstream_mode(self):
        v = build(tls="upstream", http_port=8443).values
        self.assertEqual((v["SITE_ADDRESS"], v["TLS_DIRECTIVE"], v["HTTP_PORT"]), ("http://:80", "", "8443"))

    def test_external_idp_clears_the_bundled_values(self):
        v = build(idp="external", oidc_issuer="https://id.example.org/", oidc_console_client_secret="a",
                  oidc_chat_client_secret="b").values
        self.assertEqual(v["OIDC_ISSUER"], "https://id.example.org")
        self.assertEqual(v["OIDC_INTERNAL_BASE_URL"], "")
        self.assertEqual(v["OIDC_KIND"], "generic")
        self.assertEqual(v["OIDC_LOGOUT_URL"], "")
        self.assertNotIn("authelia", v["COMPOSE_PROFILES"])

    def test_satellite_and_generic_backends(self):
        v = build(preset="satellite", central_url="https://central.example.org/",
                  oidc_chat_client_secret="c").values
        self.assertEqual(v["CHAT_OPENAI_BASE_URL"], "https://central.example.org/v1")
        self.assertEqual(v["CHAT_USE_USER_TOKEN"], "true")
        self.assertEqual(v["OIDC_ISSUER"], "https://central.example.org/authelia")
        v = build(preset="generic", idp="external", oidc_issuer="https://id.example.org",
                  oidc_chat_client_secret="c", upstream_api_key="k").values
        self.assertEqual((v["CHAT_OPENAI_API_KEY"], v["CHAT_USE_USER_TOKEN"]), ("k", "false"))
        self.assertEqual(v["GATEWAY_UPSTREAM__API_KEY"], "")

    def test_agents_switch(self):
        self.assertEqual(build(agents=True).values["CODE_AGENTS_ENABLED"], "true")
        self.assertEqual(build().values["CODE_AGENTS_ENABLED"], "")


class TestReRun(unittest.TestCase):
    def test_secrets_are_never_reminted(self):
        first = build().values
        again = build(existing=first)
        self.assertEqual(again.values, first)
        self.assertIsNone(again.admin_password)

    def test_an_origin_change_moves_what_derives_from_it(self):
        first = build().values
        v = build(existing=first, origin="https://new.example.org").values
        self.assertEqual(v["OIDC_ISSUER"], "https://new.example.org/authelia")
        self.assertEqual(v["AUTHELIA_COOKIE_DOMAIN"], "new.example.org")
        self.assertEqual(v["ACME_EMAIL"], "admin@new.example.org")
        self.assertEqual(v["GATEWAY_SECRET_KEY"], first["GATEWAY_SECRET_KEY"])
        self.assertEqual(v["AUTHELIA_STORAGE_KEY"], first["AUTHELIA_STORAGE_KEY"])

    def test_operator_edits_survive_unless_their_answer_changed(self):
        first = dict(build().values)
        first["COMPOSE_PROFILES"] += ",fetch"
        first["FETCH_BACKEND"] = "playwright"
        first["ACME_EMAIL"] = "certs@example.org"
        v = build(existing=first).values
        self.assertIn("fetch", v["COMPOSE_PROFILES"])
        self.assertEqual(v["FETCH_BACKEND"], "playwright")
        self.assertEqual(v["ACME_EMAIL"], "certs@example.org")
        v = build(existing=first, preset="homelab").values
        self.assertEqual(v["COMPOSE_PROFILES"], "gateway,chat,authelia")
        self.assertEqual(v["FETCH_BACKEND"], "direct")

    def test_a_stale_digest_is_recomputed(self):
        first = dict(build().values)
        first["OIDC_CHAT_CLIENT_SECRET"] = "rotated-by-hand"
        v = build(existing=first).values
        self.assertIs(cfg.digest_matches("rotated-by-hand", v["AUTHELIA_CHAT_CLIENT_DIGEST"]), True)

    def test_an_older_argon2_install_is_kept(self):
        first = dict(build().values)
        first["AUTHELIA_CHAT_CLIENT_DIGEST"] = "$argon2id$v=19$m=65536,t=3,p=4$abc$def"
        v = build(existing=first).values
        self.assertEqual(v["AUTHELIA_CHAT_CLIENT_DIGEST"], first["AUTHELIA_CHAT_CLIENT_DIGEST"])


class TestCommands(Deploy):
    def configure(self, *extra):
        return self.run_cli("--non-interactive", "--origin", "https://chat.example.org",
                            "--admin-email", "ops@example.org", *extra)

    def test_writes_0600_and_a_first_sign_in(self):
        code, out, err = self.configure("--tls", "internal")
        self.assertEqual(code, 0, err)
        mode = stat.S_IMODE((self.dir / ".env").stat().st_mode)
        self.assertEqual(mode, 0o600)
        sign_in = self.dir / cfg.FIRST_SIGN_IN
        self.assertEqual(stat.S_IMODE(sign_in.stat().st_mode), 0o600)
        password = next(l.split()[-1] for l in sign_in.read_text().splitlines() if l.startswith("Password:"))
        self.assertNotIn(password, out + err, "the password must never reach the terminal")
        self.assertIs(cfg.digest_matches(password, self.env()["AUTHELIA_ADMIN_PASSWORD_DIGEST"]), True)

    def test_rerun_edits_and_backs_up(self):
        self.configure()
        before = self.env()
        code, out, _ = self.configure()
        self.assertEqual(code, 0)
        self.assertIn("nothing written", out)
        code, out, _ = self.configure("--origin", "https://other.example.org")
        self.assertEqual(code, 0)
        self.assertEqual(self.env()["GATEWAY_SECRET_KEY"], before["GATEWAY_SECRET_KEY"])
        backups = list(self.dir.glob(".env.bak-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(stat.S_IMODE(backups[0].stat().st_mode), 0o600)

    def test_missing_answers_fail_non_interactively(self):
        code, _, err = self.run_cli("--non-interactive", "--origin", "https://chat.example.org")
        self.assertEqual(code, 2)
        self.assertIn("--admin-email", err)
        self.assertFalse((self.dir / ".env").exists())

    def test_a_refusal_writes_nothing(self):
        code, _, err = self.configure("--origin", "http://chat.example.org")
        self.assertEqual(code, 2)
        self.assertFalse((self.dir / ".env").exists())

    def test_set_and_unset(self):
        self.configure()
        code, out, _ = self.run_cli("--set", "PYSTINO_REGISTRY=local", "PYSTINO_VERSION=sha-abc1234")
        self.assertEqual(code, 0)
        self.assertEqual(self.env()["PYSTINO_REGISTRY"], "local")
        text = (self.dir / ".env").read_text()
        self.assertIn("PYSTINO_REGISTRY='local'", text)
        self.assertLess(text.index("PYSTINO_REGISTRY"), text.index("PUBLIC_ORIGIN"), "kept in its section")
        code, _, _ = self.run_cli("--unset", "PYSTINO_REGISTRY", "PYSTINO_VERSION")
        self.assertEqual(code, 0)
        self.assertNotIn("PYSTINO_REGISTRY", self.env())
        self.assertEqual(stat.S_IMODE((self.dir / ".env").stat().st_mode), 0o600)
        code, _, err = self.run_cli("--set", "bad key=1")
        self.assertEqual(code, 2)

    def test_check_offline(self):
        self.configure("--tls", "internal")
        report = cfg.check(self.dir, network=False, probe_host=False)
        self.assertEqual(report.errors, [])
        self.assertTrue(any(cfg.FIRST_SIGN_IN in w for w in report.warnings))

    def test_check_flags_what_an_old_install_carries(self):
        self.configure()
        values = self.env()
        values.update(COMPOSE_FILE="/old/deploy/stack/compose.yaml", PYSTINO_VERSION="0.1.0",
                      PYSTINO_REGISTRY="ghcr.io/paoloviviani")
        report = cfg.Report()
        cfg.check_values(values, report)
        self.assertTrue(any("COMPOSE_FILE" in w for w in report.warnings))
        self.assertTrue(any("PYSTINO_VERSION" in w for w in report.warnings))

    def test_check_catches_hand_edit_mistakes(self):
        self.configure()
        values = self.env()
        values["TLS_MODE"] = "internal"  # without SITE_ADDRESS/TLS_DIRECTIVE to match
        values["AUTHELIA_CHAT_CLIENT_DIGEST"] = cfg.pbkdf2_digest("something else", rounds=1000)
        values["GATEWAY_SECRET_KEY"] = ""
        report = cfg.Report()
        cfg.check_values(values, report)
        text = "\n".join(report.errors)
        self.assertIn("TLS_DIRECTIVE", text)
        self.assertIn("AUTHELIA_CHAT_CLIENT_DIGEST", text)
        self.assertIn("GATEWAY_SECRET_KEY", text)

    def test_check_upstream_does_not_probe_the_front(self):
        self.configure("--tls", "upstream", "--http-port", "8443")
        report = cfg.Report()
        with mock.patch.object(cfg, "compose_version", return_value=(9, 9)), \
                mock.patch.object(cfg, "_run", return_value=None), \
                mock.patch.object(cfg, "reachable", side_effect=AssertionError("probed")):
            cfg.check_host(self.env(), report, root=self.dir, network=True)
        self.assertFalse(any("resolve" in e or ":80" in e or ":443" in e for e in report.errors + report.warnings),
                         report.errors + report.warnings)
        self.assertTrue(any("upstream" in n for n in report.notes))

    @unittest.skipUnless(shutil.which("docker"), "needs docker")
    def test_compose_accepts_what_configure_writes(self):
        self.configure("--tls", "internal", "--agents")
        proc = subprocess.run(["docker", "compose", "config", "-q"], cwd=self.dir,
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_the_script_is_executable_with_a_shebang(self):
        path = ROOT / "configure"
        self.assertTrue(os.access(path, os.X_OK))
        self.assertTrue(path.read_text().startswith("#!/usr/bin/env python3\n"))


if __name__ == "__main__":
    unittest.main()
