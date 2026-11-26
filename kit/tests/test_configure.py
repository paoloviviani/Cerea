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
# The suite makes no network calls: ./configure reaches for the issuer's
# discovery document at `check_scopes` (via `check_values`) and in
# `cmd_configure`, and several test classes call `build()`/`check_values()`
# without the per-test patch `Deploy.setUp` applies. A hard stub answers
# None — what an unreachable issuer would say — and only the tests that
# need a document set one (they patch `fetch_discovery` themselves, in
# `Deploy`). A call that expects a document would fail its assertions, so
# the stub cannot silently stand in for one.
REAL_FETCH_DISCOVERY = cfg.fetch_discovery
cfg.fetch_discovery = lambda issuer, timeout=8.0: None
REAL_COMPOSE_ENV_PROBLEM = cfg.compose_env_problem
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
        for name in ("caddy", "authelia", "proxy.d", "providers.d"):
            shutil.copytree(ROOT / name, self.dir / name)
        # No test reaches a real issuer; one that needs a discovery document
        # sets `self.discovery`.
        self.discovery = None
        patcher = mock.patch.object(cfg, "fetch_discovery", side_effect=lambda issuer, *a, **k: self.discovery)
        self.fetch = patcher.start()
        self.addCleanup(patcher.stop)
        # The MongoDB choice reads the host's CPU and kernel; pin a capable one
        # so the suite says the same on every machine (test_mongo.py covers the rest).
        host = mock.patch.object(cfg, "detect_host", return_value=(True, "6.8.0-1-generic"))
        host.start()
        self.addCleanup(host.stop)
        # The suite does not run docker; the tests of the post-write parse check
        # patch `_run` and restore the real function themselves.
        parse = mock.patch.object(cfg, "compose_env_problem", return_value=None)
        parse.start()
        self.addCleanup(parse.stop)

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

    def test_sha512_crypt_reference_vectors(self):
        # From Drepper's specification; openssl passwd -6 and Authelia agree.
        self.assertEqual(
            cfg.sha512_crypt("Hello world!", rounds=5000, salt="saltstring"),
            "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1",
        )
        self.assertEqual(
            cfg.sha512_crypt("Hello world!", rounds=10000, salt="saltstringsaltstring"),
            "$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.",
        )

    def test_sha512_crypt_round_trip(self):
        digest = cfg.sha512_crypt("s3cret", rounds=1000)
        self.assertIs(cfg.digest_matches("s3cret", digest), True)
        self.assertIs(cfg.digest_matches("other", digest), False)

    def test_the_admin_password_digest_is_one_bootstrap_accepts(self):
        # The gateway image's bootstrap takes argon2 or $6$ for this one.
        self.assertTrue(build().values["AUTHELIA_ADMIN_PASSWORD_DIGEST"].startswith("$6$"))

    def test_argon2_digests_are_left_alone(self):
        self.assertIsNone(cfg.digest_matches("x", "$argon2id$v=19$m=65536,t=3,p=4$abc$def"))


class TestRefusals(unittest.TestCase):
    def test_http_origin(self):
        with self.assertRaisesRegex(cfg.ConfigError, "https"):
            build(origin="http://chat.example.org")

    def test_http_origin_suggests_https_and_sslip(self):
        with self.assertRaises(cfg.ConfigError) as cm:
            build(origin="http://130.192.100.139:433")
        msg = str(cm.exception)
        self.assertIn("https://130.192.100.139 or https://130-192-100-139.sslip.io", msg)

    def test_http_origin_for_a_name_suggests_only_https(self):
        self.assertEqual(cfg.origin_suggestions("http://chat.example.org:8443"),
                         ["https://chat.example.org:8443"])

    def test_sslip_origin_works_end_to_end(self):
        v = build(origin="https://130-192-100-139.sslip.io", tls="acme").values
        self.assertEqual(v["PUBLIC_ORIGIN"], "https://130-192-100-139.sslip.io")
        self.assertEqual(v["TLS_MODE"], "acme")
        self.assertEqual(v["AUTHELIA_COOKIE_DOMAIN"], "130-192-100-139.sslip.io")
        cfg.refuse_authelia("130-192-100-139.sslip.io")

    def test_interview_guides_an_http_origin_and_a_suspicious_port(self):
        printed = []
        replies = iter(["", "http://130.192.100.139:433", "", "https://130.192.100.139:433", "no", ""])
        prompts = []

        def fake_input(prompt):
            prompts.append(prompt)
            return next(replies)

        with mock.patch("builtins.input", side_effect=fake_input), \
                mock.patch("builtins.print", side_effect=lambda *x, **k: printed.append(" ".join(map(str, x)))):
            # empty (help again), http (suggest), Enter (accept first),
            # then a typed :433 refused by "no", Enter takes the corrected default
            first = cfg.ask_origin()
            self.assertEqual(first, "https://130.192.100.139")
            second = cfg.ask_origin()
        text = "\n".join(printed)
        self.assertIn("https://203-0-113-7.sslip.io", text)
        self.assertIn("an answer is needed", text)
        self.assertIn("https://130-192-100-139.sslip.io", text)
        self.assertIn("did you mean 443", text)
        self.assertEqual(second, "https://130.192.100.139")

    def test_origin_with_a_path(self):
        with self.assertRaises(cfg.ConfigError):
            build(origin="https://example.org/chat")

    def test_acme_on_an_ip(self):
        with self.assertRaisesRegex(cfg.ConfigError, "acme"):
            build(origin="https://10.0.0.5", tls="acme", idp="external")

    def test_acme_on_a_dotless_host(self):
        with self.assertRaisesRegex(cfg.ConfigError, "acme"):
            build(origin="https://chatbox", tls="acme")

    def test_authelia_on_a_dotless_host(self):
        # Authelia itself rejects a single-word cookie domain; the message
        # names what works instead.
        with self.assertRaisesRegex(cfg.ConfigError, r"single-word.*sslip\.io.*--idp external"):
            build(origin="https://myserver", tls="internal")

    def test_authelia_on_localhost_stays_refused(self):
        with self.assertRaisesRegex(cfg.ConfigError, "single-word"):
            build(origin="https://localhost", tls="internal")

    def test_authelia_on_an_ipv6_address(self):
        with self.assertRaisesRegex(cfg.ConfigError, "IPv6"):
            build(origin="https://[::1]", tls="internal")

    def test_authelia_on_an_ip_is_accepted(self):
        values = build(origin="https://10.0.0.5", tls="internal").values
        self.assertEqual(values["PUBLIC_ORIGIN"], "https://10.0.0.5")
        self.assertEqual(values["AUTHELIA_COOKIE_DOMAIN"], "10.0.0.5")
        self.assertEqual(values["OIDC_ISSUER"], "https://10.0.0.5/authelia")
        self.assertEqual(values["SITE_ADDRESS"], "https://10.0.0.5")
        self.assertEqual(values["TLS_DIRECTIVE"], "tls internal")
        # Browsers send no SNI to an IP; Caddy must be told which certificate to serve.
        self.assertEqual(values["DEFAULT_SNI_DIRECTIVE"], "default_sni 10.0.0.5")
        self.assertEqual(values["ACME_EMAIL"], "admin@example.org")
        self.assertIn("authelia", values["COMPOSE_PROFILES"].split(","))

    def test_a_name_needs_no_default_sni(self):
        values = build(tls="internal").values
        self.assertEqual(values["DEFAULT_SNI_DIRECTIVE"], "")

    def test_check_wants_the_default_sni_on_an_ip(self):
        values = dict(build(origin="https://10.0.0.5", tls="internal").values)
        report = cfg.Report()
        cfg.check_values(values, report)
        self.assertFalse(any("DEFAULT_SNI" in e for e in report.errors))
        values["DEFAULT_SNI_DIRECTIVE"] = ""
        report = cfg.Report()
        cfg.check_values(values, report)
        self.assertTrue(any("DEFAULT_SNI" in e for e in report.errors))

    def test_authelia_on_an_ip_with_a_port(self):
        values = build(origin="https://10.0.0.5:8443", tls="internal").values
        self.assertEqual(values["PUBLIC_ORIGIN"], "https://10.0.0.5:8443")
        self.assertEqual(values["HTTPS_PORT"], "8443")
        # A cookie domain never carries a port.
        self.assertEqual(values["AUTHELIA_COOKIE_DOMAIN"], "10.0.0.5")
        self.assertEqual(values["OIDC_ISSUER"], "https://10.0.0.5:8443/authelia")

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

    def test_external_idp_needs_an_admin_rule(self):
        with self.assertRaisesRegex(cfg.ConfigError, "admin rule"):
            build(idp="external", oidc_issuer="https://id.example.org",
                  oidc_console_client_secret="a", oidc_chat_client_secret="b", admin_email="")

    def test_external_idp_with_only_a_claim_rule_does_not_need_admin_email(self):
        v = build(idp="external", oidc_issuer="https://id.example.org",
                   oidc_console_client_secret="a", oidc_chat_client_secret="b", admin_email="",
                   admin_claim="groups", admin_claim_value="admin").values
        self.assertEqual(v["OIDC_ADMIN_CLAIM"], "groups")
        self.assertEqual(v["OIDC_ADMIN_CLAIM_VALUE"], "admin")
        self.assertEqual(v.get("OIDC_ADMIN_EMAIL", ""), "")

    def test_half_a_claim_pair_is_refused(self):
        with self.assertRaisesRegex(cfg.ConfigError, "together"):
            build(idp="external", oidc_issuer="https://id.example.org",
                  oidc_console_client_secret="a", oidc_chat_client_secret="b",
                  admin_claim="groups")


class TestFreshInstall(unittest.TestCase):
    def test_every_preset_satisfies_its_own_check(self):
        extra = {
            "satellite": dict(central_url="https://central.example.org", oidc_chat_client_secret="c"),
            "generic": dict(idp="external", oidc_issuer="https://id.example.org",
                            oidc_chat_client_secret="c", upstream_api_key="k", upstream_base_url="https://llm.example.org/v1"),
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
                  oidc_chat_client_secret="c", upstream_api_key="k",
                  upstream_base_url="https://llm.example.org/v1").values
        self.assertEqual((v["CHAT_OPENAI_API_KEY"], v["CHAT_USE_USER_TOKEN"]), ("k", "false"))
        self.assertEqual(v["GATEWAY_UPSTREAM__API_KEY"], "")

    def test_the_renderer_address_follows_the_fetch_profile(self):
        self.assertEqual(build(preset="enterprise").values["PLAYWRIGHT_WS_ENDPOINT"], cfg.PLAYWRIGHT_ENDPOINT)
        self.assertNotIn("PLAYWRIGHT_WS_ENDPOINT", build(preset="team").values)
        first = build(preset="enterprise").values
        self.assertNotIn("PLAYWRIGHT_WS_ENDPOINT", build(existing=first, preset="team").values)
        # Added by hand to a team install: the address comes with it.
        by_hand = dict(build().values)
        by_hand["COMPOSE_PROFILES"] += ",fetch"
        self.assertEqual(build(existing=by_hand).values["PLAYWRIGHT_WS_ENDPOINT"], cfg.PLAYWRIGHT_ENDPOINT)
        # A renderer elsewhere is not ours to remove.
        remote = dict(build().values, PLAYWRIGHT_WS_ENDPOINT="ws://browser.internal:3000/")
        self.assertEqual(build(existing=remote).values["PLAYWRIGHT_WS_ENDPOINT"], "ws://browser.internal:3000/")

    def test_the_browser_sandbox_switch_takes_on_or_off_only(self):
        # compose mounts playwright/sandbox-<value>.json: another value names no file.
        for value, errors, warned in (("", 0, False), ("on", 0, False), ("off", 0, True), ("yes", 1, False)):
            values = dict(build(preset="enterprise").values, PLAYWRIGHT_SANDBOX=value)
            report = cfg.Report()
            cfg.check_values(values, report)
            self.assertEqual(sum("PLAYWRIGHT_SANDBOX must be" in e for e in report.errors), errors, value)
            self.assertEqual(any("without its sandbox" in w for w in report.warnings), warned, value)

    def test_check_warns_when_profile_and_address_disagree(self):
        values = dict(build().values, PLAYWRIGHT_WS_ENDPOINT=cfg.PLAYWRIGHT_ENDPOINT)
        report = cfg.Report()
        cfg.check_values(values, report)
        self.assertTrue(any("fetch profile is off" in w for w in report.warnings), report.warnings)
        values = dict(build(preset="enterprise").values, REDACTION_IMAGE="local/x-ner")
        values.pop("PLAYWRIGHT_WS_ENDPOINT")
        report = cfg.Report()
        cfg.check_values(values, report)
        self.assertTrue(any("PLAYWRIGHT_WS_ENDPOINT is empty" in w for w in report.warnings), report.warnings)
        report = cfg.Report()
        cfg.check_values(build(preset="enterprise").values | {"REDACTION_IMAGE": "local/x-ner"}, report)
        self.assertFalse(any("PLAYWRIGHT" in w for w in report.warnings), report.warnings)

    def test_agents_switch(self):
        self.assertEqual(build(agents=True).values["CODE_AGENTS_ENABLED"], "true")
        self.assertEqual(build().values["CODE_AGENTS_ENABLED"], "")

    def test_the_interview_asks_about_coding_agents_defaulting_to_yes(self):
        printed = []
        a = answers(agents=True)
        given = {"share_mode", "origin", "admin_email", "preset", "tls", "idp", "office", "rustfs", "upstream_base_url"}
        with mock.patch("builtins.input", return_value=""), \
                mock.patch.object(cfg, "refuse_authelia", return_value=None), \
                mock.patch("builtins.print", side_effect=lambda *x, **k: printed.append(" ".join(map(str, x)))):
            result = cfg.interview(a, given, {})
        self.assertTrue(result.agents)
        self.assertTrue(any("Coding agents (galopin on users' computers)?" in p for p in printed), printed)
        self.assertTrue(any("per group in the Pystino console" in p for p in printed), printed)

    def test_the_interview_agents_answer_no_and_a_rerun_default(self):
        given = {"share_mode", "origin", "admin_email", "preset", "tls", "idp", "office", "rustfs", "upstream_base_url"}
        with mock.patch("builtins.input", return_value="no"), \
                mock.patch.object(cfg, "refuse_authelia", return_value=None), \
                mock.patch("builtins.print"):
            self.assertFalse(cfg.interview(answers(agents=True), given, {}).agents)
        # An existing .env that has them off keeps them off on Enter.
        with mock.patch("builtins.input", return_value=""), \
                mock.patch.object(cfg, "refuse_authelia", return_value=None), \
                mock.patch("builtins.print"):
            self.assertFalse(cfg.interview(answers(agents=False), given, {"X": "1"}).agents)

    def test_the_agents_flag_is_not_asked_and_a_rerun_keeps_the_value(self):
        printed = []
        given = {"share_mode", "origin", "admin_email", "preset", "tls", "idp", "office", "rustfs", "agents"}
        with mock.patch("builtins.input", return_value=""), \
                mock.patch.object(cfg, "refuse_authelia", return_value=None), \
                mock.patch("builtins.print", side_effect=lambda *x, **k: printed.append(" ".join(map(str, x)))):
            cfg.interview(answers(agents=False), given, {})
        self.assertFalse(any("Coding agents" in p for p in printed))
        on = dict(build(agents=True).values)
        self.assertEqual(build(existing=on).values["CODE_AGENTS_ENABLED"], "true")
        self.assertEqual(build(existing=on, agents=False).values["CODE_AGENTS_ENABLED"], "")

    def test_a_fresh_install_has_no_default_provider(self):
        self.assertEqual(build().values["GATEWAY_UPSTREAM__BASE_URL"], "")
        self.assertNotIn("cortecs", (ROOT / "compose.yaml").read_text().lower())
        with self.assertRaisesRegex(cfg.ConfigError, "endpoint's URL"):
            build(preset="generic", idp="external", oidc_issuer="https://id.example.org",
                  upstream_api_key="k")
        kept = dict(build(upstream_base_url="https://api.example.org/v1").values)
        self.assertEqual(build(existing=kept).values["GATEWAY_UPSTREAM__BASE_URL"], "https://api.example.org/v1")

    def test_the_upstream_question_is_optional_and_skips_the_key_when_empty(self):
        prompts = []

        def fake_input(prompt):
            prompts.append(prompt)
            return ""

        given = {"share_mode", "origin", "admin_email", "preset", "tls", "idp", "office", "rustfs", "agents"}
        with mock.patch("builtins.input", side_effect=fake_input), \
                mock.patch("getpass.getpass", side_effect=AssertionError("key asked")), \
                mock.patch.object(cfg, "refuse_authelia", return_value=None), \
                mock.patch("builtins.print"):
            result = cfg.interview(answers(), given, {})
        self.assertIsNone(result.upstream_base_url)
        self.assertTrue(any("leave empty to add providers in the console" in p for p in prompts), prompts)

    def test_browser_switch_and_passthrough(self):
        self.assertEqual(build().values["CHAT_BROWSER_ENABLED"], "")
        self.assertEqual(build(browser=True).values["CHAT_BROWSER_ENABLED"], "true")
        on = dict(build(browser=True).values)
        # A re-run keeps it; --no-browser turns it off.
        self.assertEqual(build(existing=on).values["CHAT_BROWSER_ENABLED"], "true")
        self.assertEqual(build(existing=on, browser=False).values["CHAT_BROWSER_ENABLED"], "")
        compose = (ROOT / "compose.yaml").read_text()
        for key in ("ENABLED", "MODEL", "MAX_STEPS", "MAX_TOKENS", "MAX_SECONDS", "SITES_ALLOW", "SITES_DENY"):
            self.assertIn(f"CHAT_BROWSER_{key}: ${{CHAT_BROWSER_{key}:-}}", compose)
            self.assertIn(f"CHAT_BROWSER_{key}=", (ROOT / ".env.example").read_text())

    def test_terminal_switch_needs_agents(self):
        self.assertEqual(build(agents=True, terminal=True).values["CODE_TERMINAL_ENABLED"], "true")
        self.assertEqual(build(agents=True).values["CODE_TERMINAL_ENABLED"], "")
        # No agent machines, no terminal, whatever was asked.
        self.assertEqual(build(terminal=True).values["CODE_TERMINAL_ENABLED"], "")
        # A re-run keeps it, and --no-agents turns it off with them.
        first = dict(build(agents=True, terminal=True).values)
        self.assertEqual(build(existing=first).values["CODE_TERMINAL_ENABLED"], "true")
        self.assertEqual(build(existing=first, agents=False).values["CODE_TERMINAL_ENABLED"], "")

    def _fetch_state(self, values):
        profiles = [p for p in values["COMPOSE_PROFILES"].split(",") if p]
        return ("fetch" in profiles, values.get("FETCH_BACKEND"), values.get("PLAYWRIGHT_WS_ENDPOINT"))

    def test_fetch_flag_adds_and_removes_the_browser(self):
        team = dict(build().values)
        self.assertEqual(self._fetch_state(team), (False, "direct", None))
        on = dict(build(existing=team, fetch=True).values)
        self.assertEqual(self._fetch_state(on), (True, "playwright", cfg.PLAYWRIGHT_ENDPOINT))
        # A re-run without the flag keeps the choice.
        self.assertEqual(self._fetch_state(build(existing=on).values), self._fetch_state(on))
        off = build(existing=on, fetch=False).values
        self.assertEqual(self._fetch_state(off), (False, "direct", None))

    def test_a_foreign_renderer_is_kept_by_both_flags(self):
        foreign = "ws://render.example.org:3000/"
        existing = dict(build().values) | {"PLAYWRIGHT_WS_ENDPOINT": foreign}
        on = build(existing=existing, fetch=True).values
        self.assertEqual(on["PLAYWRIGHT_WS_ENDPOINT"], foreign)
        self.assertEqual(on["FETCH_BACKEND"], "playwright")
        result = build(existing=dict(on), fetch=False)
        self.assertEqual(result.values["PLAYWRIGHT_WS_ENDPOINT"], foreign)
        self.assertEqual(result.values["FETCH_BACKEND"], "playwright")
        self.assertNotIn("fetch", result.values["COMPOSE_PROFILES"].split(","))
        self.assertTrue(any(foreign in n for n in result.notes), result.notes)

    def test_no_fetch_on_enterprise_and_fetch_on_satellite(self):
        ent = dict(build(preset="enterprise").values)
        self.assertEqual(self._fetch_state(ent)[0], True)
        off = build(existing=ent, preset="enterprise", fetch=False).values
        self.assertEqual(self._fetch_state(off), (False, "direct", None))
        sat_kw = dict(preset="satellite", central_url="https://central.example.org",
                      oidc_chat_client_secret="c")
        sat = dict(build(**sat_kw).values)
        on = build(existing=sat, fetch=True, **sat_kw).values
        self.assertEqual(self._fetch_state(on), (True, "playwright", cfg.PLAYWRIGHT_ENDPOINT))

    def test_fetch_flag_leaves_check_quiet(self):
        existing = dict(build().values)
        for flag in (True, False):
            values = build(existing=existing, fetch=flag).values
            existing = dict(values)
            report = cfg.Report()
            cfg.check_values(values, report)
            self.assertFalse(any("PLAYWRIGHT" in w or "FETCH_BACKEND" in w for w in report.warnings),
                             report.warnings)

    def _office_state(self, values):
        profiles = [p for p in values["COMPOSE_PROFILES"].split(",") if p]
        return ("office" in profiles, values.get("CHAT_GOTENBERG_URL"))

    def test_office_is_off_by_default_in_every_preset(self):
        for preset in ("homelab", "team", "enterprise"):
            self.assertEqual(self._office_state(build(preset=preset).values), (False, None), preset)

    def test_office_flag_adds_and_removes_gotenberg(self):
        team = dict(build().values)
        on = dict(build(existing=team, office=True).values)
        self.assertEqual(self._office_state(on), (True, cfg.GOTENBERG_ENDPOINT))
        # A re-run without the flag keeps the choice, and the fetch browser is untouched.
        self.assertEqual(self._office_state(build(existing=on).values), self._office_state(on))
        self.assertEqual(self._fetch_state(on), self._fetch_state(team))
        off = build(existing=on, office=False).values
        self.assertEqual(self._office_state(off), (False, None))

    def test_redaction_url_follows_the_redaction_profile(self):
        team = build(preset="team").values  # the team preset runs redaction
        self.assertIn("redaction", team["COMPOSE_PROFILES"].split(","))
        self.assertEqual(team.get("CHAT_REDACTION_URL"), cfg.REDACTION_ENDPOINT)
        homelab = build(preset="homelab").values
        self.assertNotIn("redaction", homelab["COMPOSE_PROFILES"].split(","))
        self.assertNotIn("CHAT_REDACTION_URL", homelab)

    def test_redaction_url_is_dropped_when_the_profile_goes_off(self):
        team = dict(build(preset="team").values)
        self.assertEqual(team.get("CHAT_REDACTION_URL"), cfg.REDACTION_ENDPOINT)
        profiles = [p for p in team["COMPOSE_PROFILES"].split(",") if p and p != "redaction"]
        off = build(existing=team | {"COMPOSE_PROFILES": ",".join(profiles)}).values
        self.assertNotIn("redaction", off["COMPOSE_PROFILES"].split(","))
        self.assertNotIn("CHAT_REDACTION_URL", off)

    def test_a_foreign_redaction_url_is_kept_when_the_profile_is_off(self):
        foreign = "http://redaction.example.org:8080"
        team = dict(build(preset="team").values)
        profiles = [p for p in team["COMPOSE_PROFILES"].split(",") if p and p != "redaction"]
        existing = team | {"COMPOSE_PROFILES": ",".join(profiles), "CHAT_REDACTION_URL": foreign}
        self.assertEqual(build(existing=existing).values["CHAT_REDACTION_URL"], foreign)

    def test_a_foreign_converter_is_kept_by_both_flags(self):
        foreign = "http://convert.example.org:3000"
        existing = dict(build().values) | {"CHAT_GOTENBERG_URL": foreign}
        self.assertEqual(build(existing=existing, office=True).values["CHAT_GOTENBERG_URL"], foreign)
        result = build(existing=dict(build(existing=existing, office=True).values), office=False)
        self.assertEqual(result.values["CHAT_GOTENBERG_URL"], foreign)
        self.assertNotIn("office", result.values["COMPOSE_PROFILES"].split(","))
        self.assertTrue(any(foreign in n for n in result.notes), result.notes)

    def test_office_flag_leaves_check_quiet_and_a_mismatch_warns(self):
        existing = dict(build().values)
        for flag in (True, False):
            values = build(existing=existing, office=flag).values
            existing = dict(values)
            report = cfg.Report()
            cfg.check_values(values, report)
            self.assertFalse(any("GOTENBERG" in w or "office" in w for w in report.warnings), report.warnings)
        on = dict(build(office=True).values)
        on["CHAT_GOTENBERG_URL"] = ""
        report = cfg.Report()
        cfg.check_values(on, report)
        self.assertTrue(any("CHAT_GOTENBERG_URL is empty" in w for w in report.warnings), report.warnings)
        off = dict(build().values) | {"CHAT_GOTENBERG_URL": cfg.GOTENBERG_ENDPOINT}
        report = cfg.Report()
        cfg.check_values(off, report)
        self.assertTrue(any("office profile is off" in w for w in report.warnings), report.warnings)

    def test_the_env_file_carries_the_converter_address(self):
        text = cfg.render(TEMPLATE, build(office=True).values, "# header")
        self.assertIn("CHAT_GOTENBERG_URL='http://gotenberg:3000'", text)
        self.assertIn("office", [l for l in text.splitlines() if l.startswith("COMPOSE_PROFILES=")][0])
        self.assertNotIn("\nCHAT_GOTENBERG_URL=", cfg.render(TEMPLATE, build().values, "# header"))

    def test_defaults_for_the_new_adr_0093_fields(self):
        v = build().values
        self.assertEqual(v["OIDC_GROUP_SYNC"], "every_login")
        self.assertEqual(v["OIDC_LINK_BY_EMAIL"], "false")
        self.assertEqual(v["OIDC_MACHINE_CLIENT_ID"], "opencode-enrollment")
        self.assertEqual(v["SMTP_ENABLED"], "false")
        self.assertEqual(v["SMTP_PORT"], "587")
        self.assertEqual(v["SMTP_SECURITY"], "starttls")

    def test_group_sync_and_link_by_email_and_machine_client_id(self):
        v = build(group_sync="never", link_by_email=True, machine_client_id="my-agent").values
        self.assertEqual(v["OIDC_GROUP_SYNC"], "never")
        self.assertEqual(v["OIDC_LINK_BY_EMAIL"], "true")
        self.assertEqual(v["OIDC_MACHINE_CLIENT_ID"], "my-agent")

    _EXTERNAL = dict(idp="external", oidc_issuer="https://gitlab.example.org",
                     oidc_console_client_secret="a", oidc_chat_client_secret="b")

    def test_external_idp_imports_groups_by_hand_by_default(self):
        v = build(**self._EXTERNAL).values
        self.assertEqual(v["OIDC_GROUP_IMPORT"], "manual")
        self.assertEqual(v["OIDC_DEFAULT_GROUP"], "users")
        self.assertEqual(v["OIDC_GROUP_ALLOWLIST"], "")

    def test_group_import_auto_is_written_and_kept_on_a_rerun(self):
        first = dict(build(group_import="auto", **self._EXTERNAL).values)
        self.assertEqual(first["OIDC_GROUP_IMPORT"], "auto")
        self.assertEqual(build(existing=first, **self._EXTERNAL).values["OIDC_GROUP_IMPORT"], "auto")
        back = build(existing=first, group_import="manual", **self._EXTERNAL).values
        self.assertEqual(back["OIDC_GROUP_IMPORT"], "manual")

    def test_an_older_env_without_the_line_gets_manual(self):
        older = dict(build(**self._EXTERNAL).values)
        del older["OIDC_GROUP_IMPORT"]
        self.assertEqual(build(existing=older, **self._EXTERNAL).values["OIDC_GROUP_IMPORT"], "manual")

    def test_a_hand_set_allowlist_and_default_group_survive_a_rerun(self):
        first = dict(build(**self._EXTERNAL).values)
        first["OIDC_GROUP_ALLOWLIST"] = "eng,ops"
        first["OIDC_DEFAULT_GROUP"] = ""
        v = build(existing=first, **self._EXTERNAL).values
        self.assertEqual(v["OIDC_GROUP_ALLOWLIST"], "eng,ops")
        self.assertEqual(v["OIDC_DEFAULT_GROUP"], "")

    def test_the_interview_asks_about_group_import_for_an_external_idp(self):
        prompts = []
        printed = []

        def fake_input(prompt):
            prompts.append(prompt)
            if not prompt.startswith("choice"):
                return ""
            # Each choice question is answered by its own block, whichever
            # was printed last: the join-mode question (ADR 0095) must not
            # inherit the group-import answer, and its validator would loop
            # forever on a wrong one.
            for wanted, marker in (("auto", "Groups from the identity provider:"),
                                   ("approval", "Who may join:")):
                if marker in printed and printed.index(marker) > max(
                    (printed.index(m) for m in
                     ("Groups from the identity provider:", "Who may join:") if m in printed
                     and m is not marker),
                    default=-1,
                ):
                    return wanted
            return ""

        a = answers(**self._EXTERNAL)
        given = {"share_mode", "origin", "admin_email", "preset", "tls", "idp", "oidc_issuer",
                 "oidc_console_client_secret", "oidc_chat_client_secret", "office", "rustfs", "agents"}
        with mock.patch("builtins.input", side_effect=fake_input), \
                mock.patch("builtins.print", side_effect=lambda *x, **k: printed.append(" ".join(map(str, x)))):
            result = cfg.interview(a, given, {})
        self.assertEqual(result.group_import, "auto")
        self.assertTrue(any("import by hand (recommended)" in p for p in printed), printed)
        # The join question was asked and took its default (approval for a
        # fresh install); it is not answered by the group-import choice.
        self.assertEqual(result.join_mode, "approval")
        self.assertTrue(any("Who may join:" in p for p in printed), printed)

    def test_the_interview_does_not_ask_with_the_bundled_authelia(self):
        printed = []
        a = answers(idp="authelia")
        given = {"share_mode", "origin", "admin_email", "preset", "tls", "idp"}
        with mock.patch("builtins.input", return_value=""), \
                mock.patch.object(cfg, "refuse_authelia", return_value=None), \
                mock.patch("builtins.print", side_effect=lambda *x, **k: printed.append(" ".join(map(str, x)))):
            result = cfg.interview(a, given, {})
        self.assertIsNone(result.group_import)
        self.assertFalse(any("Groups from the identity provider" in p for p in printed))

    def test_smtp_host_turns_mail_on_and_clearing_it_turns_mail_off(self):
        v = build(smtp_host="smtp.example.org", smtp_port=465, smtp_username="u",
                   smtp_password="p", smtp_from="noreply@example.org", smtp_security="tls").values
        self.assertEqual(v["SMTP_ENABLED"], "true")
        self.assertEqual(v["SMTP_HOST"], "smtp.example.org")
        self.assertEqual(v["SMTP_PORT"], "465")
        self.assertEqual(v["SMTP_SECURITY"], "tls")
        cleared = build(existing=v, smtp_host="").values
        self.assertEqual(cleared["SMTP_ENABLED"], "false")
        self.assertEqual(cleared["SMTP_HOST"], "")


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
        self.assertEqual(v["COMPOSE_PROFILES"], "gateway,chat,authelia,documents")
        self.assertEqual(v["FETCH_BACKEND"], "direct")

    def test_a_pystino_only_env_moves_over(self):
        # Pystino's deploy/.env.example: the same names, no preset, no chat.
        pystino_only = {
            "COMPOSE_PROJECT_NAME": "pystino", "COMPOSE_PROFILES": "authelia",
            "PUBLIC_ORIGIN": "https://chat.example.org", "TLS_MODE": "acme",
            "POSTGRES_PASSWORD": "kept-pg", "GATEWAY_SECRET_KEY": "kept-key",
            "PYSTINO_BOOTSTRAP_ADMIN_EMAIL": "ops@example.org",
        }
        v = build(existing=pystino_only).values
        self.assertEqual(v["COMPOSE_PROFILES"], "gateway,chat,authelia,redaction")
        self.assertEqual(v["COMPOSE_PROJECT_NAME"], "pystino")  # its volumes
        self.assertEqual((v["POSTGRES_PASSWORD"], v["GATEWAY_SECRET_KEY"]), ("kept-pg", "kept-key"))
        self.assertTrue(v["CHAT_SECRET_KEY"] and v["OIDC_CHAT_CLIENT_SECRET"] and v["AUTHELIA_CHAT_CLIENT_DIGEST"])
        report = cfg.Report()
        cfg.check_values(v, report)
        self.assertEqual(report.errors, [])

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


class TestVapid(unittest.TestCase):
    """Web Push keys: minted once, a real P-256 pair, subject from the admin."""

    def test_the_curve_maths_matches_known_points(self):
        # d = 1 is the generator itself; d = 2 is a published doubling vector.
        one = cfg.p256_public((1).to_bytes(32, "big"))
        self.assertEqual(one[1:33].hex(), "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296")
        two = cfg.p256_public((2).to_bytes(32, "big"))
        self.assertEqual(two[1:33].hex(), "7cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc47669978")
        self.assertEqual(two[33:].hex(), "07775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1")

    def test_a_fresh_install_gets_a_pair_and_a_subject(self):
        v = build().values
        self.assertEqual(len(cfg._unb64url(v["CHAT_VAPID_PUBLIC_KEY"])), 65)
        self.assertEqual(len(cfg._unb64url(v["CHAT_VAPID_PRIVATE_KEY"])), 32)
        self.assertIsNone(cfg.vapid_pair_problem(v["CHAT_VAPID_PRIVATE_KEY"], v["CHAT_VAPID_PUBLIC_KEY"]))
        self.assertEqual(v["CHAT_VAPID_SUBJECT"], "mailto:ops@example.org")

    def test_a_rerun_never_regenerates_the_pair(self):
        first = dict(build().values)
        again = build(existing=first, admin_email="other@example.org").values
        for key in ("CHAT_VAPID_PUBLIC_KEY", "CHAT_VAPID_PRIVATE_KEY", "CHAT_VAPID_SUBJECT"):
            self.assertEqual(again[key], first[key])

    def test_a_missing_public_half_is_derived_not_reminted(self):
        first = dict(build().values)
        first.pop("CHAT_VAPID_PUBLIC_KEY")
        again = build(existing=first).values
        self.assertEqual(again["CHAT_VAPID_PRIVATE_KEY"], first["CHAT_VAPID_PRIVATE_KEY"])
        self.assertIsNone(cfg.vapid_pair_problem(again["CHAT_VAPID_PRIVATE_KEY"], again["CHAT_VAPID_PUBLIC_KEY"]))

    def test_a_mismatched_pair_is_a_warning(self):
        first = dict(build().values)
        first["CHAT_VAPID_PUBLIC_KEY"] = cfg.mint_vapid()[1]
        report = cfg.Report()
        cfg.check_values(first, report)
        self.assertTrue(any("CHAT_VAPID" in w for w in report.warnings), report.warnings)

    def test_a_good_pair_raises_nothing(self):
        report = cfg.Report()
        cfg.check_values(build().values, report)
        self.assertFalse(any("CHAT_VAPID" in w for w in report.warnings + report.errors))


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

    def test_import_smtp_reads_pystino_email_export_env(self):
        exported = (
            "SMTP_HOST=smtp.example.org\nSMTP_PORT=465\nSMTP_USERNAME=u\n"
            "SMTP_PASSWORD=p\nSMTP_FROM=noreply@example.org\nSMTP_SECURITY=tls\n"
        )
        with mock.patch.object(
            cfg, "_run",
            return_value=subprocess.CompletedProcess([], 0, stdout=exported, stderr=""),
        ):
            code, _, err = self.configure("--import-smtp")
        self.assertEqual(code, 0, err)
        v = self.env()
        self.assertEqual(v["SMTP_HOST"], "smtp.example.org")
        self.assertEqual(v["SMTP_PORT"], "465")
        self.assertEqual(v["SMTP_SECURITY"], "tls")
        self.assertEqual(v["SMTP_ENABLED"], "true")

    def test_import_smtp_failing_does_not_stop_the_write(self):
        with mock.patch.object(cfg, "_run", return_value=None):
            code, _, err = self.configure("--import-smtp")
        self.assertEqual(code, 0, err)
        self.assertIn("--import-smtp", err)
        v = self.env()
        self.assertEqual(v["SMTP_ENABLED"], "false")

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

    def test_check_wants_providers_dir(self):
        self.configure("--tls", "internal")
        shutil.rmtree(self.dir / "providers.d")
        report = cfg.check(self.dir, network=False, probe_host=False)
        self.assertTrue(any("providers.d/ is missing" in e for e in report.errors))

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

    def test_check_flags_a_bad_group_sync(self):
        self.configure()
        values = self.env()
        values["OIDC_GROUP_SYNC"] = "sometimes"
        report = cfg.Report()
        cfg.check_values(values, report)
        self.assertTrue(any("OIDC_GROUP_SYNC" in e for e in report.errors), report.errors)

    def test_check_flags_a_bad_group_import(self):
        self.configure()
        values = self.env()
        values["OIDC_GROUP_IMPORT"] = "sometimes"
        report = cfg.Report()
        cfg.check_values(values, report)
        self.assertTrue(any("OIDC_GROUP_IMPORT" in e for e in report.errors), report.errors)

    def test_the_group_import_flag_writes_env(self):
        code, _, err = self.configure(
            "--idp", "external", "--oidc-issuer", "https://gitlab.example.org",
            "--oidc-console-client-secret", "a", "--oidc-chat-client-secret", "b",
            "--group-import", "auto")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.env()["OIDC_GROUP_IMPORT"], "auto")

    def test_check_warns_link_by_email_on(self):
        self.configure()
        values = self.env()
        values["OIDC_LINK_BY_EMAIL"] = "true"
        report = cfg.Report()
        cfg.check_values(values, report)
        self.assertTrue(any("OIDC_LINK_BY_EMAIL" in w for w in report.warnings), report.warnings)

    def test_check_warns_team_preset_without_smtp(self):
        self.configure()
        values = self.env()
        self.assertEqual(values["PYSTINO_PRESET"], "team")
        report = cfg.Report()
        cfg.check_values(values, report)
        self.assertTrue(any("SMTP_HOST" in w for w in report.warnings), report.warnings)

    def test_check_notes_bundled_authelia_without_smtp(self):
        self.configure("--preset", "homelab")
        values = self.env()
        report = cfg.Report()
        cfg.check_values(values, report)
        self.assertTrue(any("one-time password" in n for n in report.notes), report.notes)

    def test_check_refuses_smtp_values_that_would_break_the_yaml_template(self):
        """configuration.yml quotes SMTP_HOST/USERNAME/FROM with Authelia's own
        `msquote`, which does not escape an embedded quote -- a value
        `configure` let through would render a broken configuration.yml, not
        just a rejected one. Refusing it here is the only place that can
        actually stop that."""
        self.configure("--smtp-host", "mail.example.org", "--smtp-from", "noreply@example.org")
        for key, hostile in (
            ("SMTP_HOST", "mail.example.org'; drop:"),
            ("SMTP_USERNAME", "o'brien"),
            ("SMTP_FROM", "noreply@example.org\nX-Injected: true"),
        ):
            with self.subTest(key):
                values = self.env()
                values[key] = hostile
                report = cfg.Report()
                cfg.check_values(values, report)
                self.assertTrue(any(key in e for e in report.errors), report.errors)

    def test_check_flags_a_non_numeric_smtp_port(self):
        self.configure("--smtp-host", "mail.example.org", "--smtp-from", "noreply@example.org")
        values = self.env()
        values["SMTP_PORT"] = "587; rm -rf"
        report = cfg.Report()
        cfg.check_values(values, report)
        self.assertTrue(any("SMTP_PORT" in e for e in report.errors), report.errors)

    def test_check_flags_a_missing_reset_password_secret_only_with_smtp(self):
        """An install that pulls this compose update without re-running
        ./configure has AUTHELIA_RESET_PASSWORD_JWT_SECRET empty. That must
        not be an error unless they also have SMTP_HOST set -- their
        existing, SMTP-less setup keeps validating exactly as it did."""
        self.configure("--preset", "homelab")
        values = self.env()
        values["AUTHELIA_RESET_PASSWORD_JWT_SECRET"] = ""
        report = cfg.Report()
        cfg.check_values(values, report)
        self.assertFalse(any("AUTHELIA_RESET_PASSWORD_JWT_SECRET" in e for e in report.errors), report.errors)

        values["SMTP_HOST"] = "mail.example.org"
        report = cfg.Report()
        cfg.check_values(values, report)
        self.assertTrue(any("AUTHELIA_RESET_PASSWORD_JWT_SECRET" in e for e in report.errors), report.errors)

    def test_configure_mints_the_reset_password_secret(self):
        self.configure("--smtp-host", "mail.example.org", "--smtp-from", "noreply@example.org")
        values = self.env()
        self.assertGreaterEqual(len(values["AUTHELIA_RESET_PASSWORD_JWT_SECRET"]), 48)

    def test_check_flags_an_external_idp_with_no_admin_rule(self):
        self.configure("--idp", "external", "--oidc-issuer", "https://id.example.org",
                       "--oidc-console-client-secret", "a", "--oidc-chat-client-secret", "b",
                       "--admin-claim", "groups", "--admin-claim-value", "admin")
        values = self.env()
        values["OIDC_ADMIN_CLAIM"] = ""
        values["OIDC_ADMIN_CLAIM_VALUE"] = ""
        report = cfg.Report()
        cfg.check_values(values, report)
        self.assertTrue(any("admin rule" in e for e in report.errors), report.errors)

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

    def test_fetch_flag_on_an_existing_env_changes_only_the_browser(self):
        self.configure("--tls", "internal")
        before = self.env()
        code, out, err = self.run_cli("--non-interactive", "--fetch")
        self.assertEqual(code, 0, err)
        after = self.env()
        self.assertIn("fetch", after["COMPOSE_PROFILES"].split(","))
        self.assertEqual(after["FETCH_BACKEND"], "playwright")
        self.assertEqual(after["PLAYWRIGHT_WS_ENDPOINT"], cfg.PLAYWRIGHT_ENDPOINT)
        self.assertEqual(after["PUBLIC_ORIGIN"], before["PUBLIC_ORIGIN"])
        self.assertIn("fetch", out)
        code, out, err = self.run_cli("--non-interactive")
        self.assertIn("fetch", self.env()["COMPOSE_PROFILES"].split(","))
        code, out, err = self.run_cli("--non-interactive", "--no-fetch")
        self.assertEqual(code, 0, err)
        gone = self.env()
        self.assertNotIn("fetch", gone["COMPOSE_PROFILES"].split(","))
        self.assertNotIn("PLAYWRIGHT_WS_ENDPOINT", gone)
        self.assertEqual(gone["FETCH_BACKEND"], "direct")
        code, out, err = self.run_cli("--check", "--offline")
        self.assertNotIn("PLAYWRIGHT", out + err)

    def test_the_script_is_executable_with_a_shebang(self):
        path = ROOT / "configure"
        self.assertTrue(os.access(path, os.X_OK))
        self.assertTrue(path.read_text().startswith("#!/usr/bin/env python3\n"))


class TestBreakGlass(TestCommands):
    """`./configure --break-glass` (ADR 0093 §10 host steps). Every
    `docker compose`/`pystino break-glass` call is mocked at `cfg._run`: what
    is under test is the `.env` rewrite, the backup, and the call order and
    stop-on-first-failure, not docker itself (`test_compose_accepts_what_
    configure_writes` already covers that compose accepts what this script
    writes)."""

    def _mock_run(self, *, break_glass_stdout="login:    ops\npassword: hunter2\n", fail_at=None):
        calls = []

        def fake_run(cmd, timeout=30, cwd=None):
            index = len(calls)
            calls.append(cmd)
            if fail_at is not None and index == fail_at:
                return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="boom")
            if cmd[:5] == ["docker", "compose", "run", "--rm", "--no-deps"]:
                return subprocess.CompletedProcess(cmd, 0, stdout=break_glass_stdout, stderr="")
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

        return calls, fake_run

    def test_needs_an_existing_env(self):
        code, _, err = self.run_cli(
            "--break-glass", "--admin-email", "ops@example.org", "--reason", "x"
        )
        self.assertEqual(code, 2)
        self.assertIn("run ./configure first", err)

    def test_needs_admin_email_but_not_a_reason(self):
        self.configure()
        code, _, err = self.run_cli("--break-glass", "--reason", "x")
        self.assertEqual(code, 2)
        self.assertIn("--admin-email", err)
        code, _, err = self.run_cli("--break-glass")
        self.assertNotIn("--reason", err)

    def test_switches_to_bundled_with_a_utc_backup_and_the_right_call_order(self):
        self.configure(
            "--idp", "external", "--oidc-issuer", "https://idp.example.org",
            "--oidc-console-client-secret", "s1", "--oidc-chat-client-secret", "s2",
        )
        calls, fake_run = self._mock_run()
        with mock.patch.object(cfg, "_run", side_effect=fake_run):
            code, out, err = self.run_cli(
                "--break-glass", "--admin-email", "ops@example.org",
                "--admin-login", "ops", "--reason", "lost every admin",
            )
        self.assertEqual(code, 0, err)

        v = self.env()
        self.assertEqual(v["OIDC_KIND"], "authelia")
        self.assertEqual(v["OIDC_LINK_BY_EMAIL"], "false")
        self.assertIn("authelia", v["COMPOSE_PROFILES"].split(","))
        # The bundled issuer replaces the external one in the live .env --
        # only the backup keeps the external value (asserted below), which
        # is what makes the round trip back out possible.
        self.assertEqual(v["OIDC_ISSUER"], "https://chat.example.org/authelia")

        backups = list(self.dir.glob(".env.bak-*"))
        self.assertEqual(len(backups), 1)
        self.assertRegex(backups[0].name, r"\.env\.bak-\d{8}T\d{6}Z$")
        self.assertEqual(stat.S_IMODE(backups[0].stat().st_mode), 0o600)
        self.assertEqual(cfg.parse_env(backups[0].read_text())["OIDC_ISSUER"], "https://idp.example.org")

        self.assertEqual(calls[0], ["docker", "compose", "up", "-d", "--wait", "postgres"])
        self.assertEqual(calls[1], ["docker", "compose", "run", "--rm", "bootstrap"])
        self.assertEqual(
            calls[2][:8],
            ["docker", "compose", "run", "--rm", "--no-deps", "gateway", "pystino", "break-glass"],
        )
        self.assertEqual(calls[2][calls[2].index("--email") + 1], "ops@example.org")
        self.assertEqual(calls[2][calls[2].index("--reason") + 1], "lost every admin")
        self.assertEqual(calls[2][calls[2].index("--login") + 1], "ops")
        self.assertEqual(calls[3], ["docker", "compose", "up", "-d", "--wait"])

        self.assertIn("ops", out)
        self.assertIn("hunter2", out)
        self.assertIn("https://chat.example.org/", out)
        self.assertIn("re-enroll", out)

    def test_forces_link_by_email_off_even_when_it_was_on(self):
        # The happy-path test above starts from OIDC_LINK_BY_EMAIL unset
        # (false by default), which never proves the forcing -- it would
        # pass even if --break-glass just left the existing value alone.
        self.configure(
            "--idp", "external", "--oidc-issuer", "https://idp.example.org",
            "--oidc-console-client-secret", "s1", "--oidc-chat-client-secret", "s2",
            "--link-by-email",
        )
        self.assertEqual(self.env()["OIDC_LINK_BY_EMAIL"], "true")

        calls, fake_run = self._mock_run()
        with mock.patch.object(cfg, "_run", side_effect=fake_run):
            code, out, err = self.run_cli(
                "--break-glass", "--admin-email", "ops@example.org", "--reason", "lost every admin",
            )
        self.assertEqual(code, 0, err)
        self.assertEqual(self.env()["OIDC_LINK_BY_EMAIL"], "false")

    def test_stops_at_the_first_failing_step_and_names_the_backup(self):
        self.configure()
        calls, fake_run = self._mock_run(fail_at=1)  # the bootstrap step
        with mock.patch.object(cfg, "_run", side_effect=fake_run):
            code, out, err = self.run_cli(
                "--break-glass", "--admin-email", "ops@example.org", "--reason", "lost every admin",
            )
        self.assertEqual(code, 1)
        self.assertIn("bootstrap", err)
        backups = list(self.dir.glob(".env.bak-*"))
        self.assertEqual(len(backups), 1)
        self.assertIn(backups[0].name, err)
        # .env was already switched before the failing step -- the message
        # points at the backup rather than claim nothing happened.
        self.assertEqual(self.env()["OIDC_KIND"], "authelia")
        # up -d --wait (the last step) never ran.
        self.assertEqual(len(calls), 2)

    def test_a_break_glass_reply_without_login_or_password_is_a_failure(self):
        self.configure()
        calls, fake_run = self._mock_run(break_glass_stdout="something went sideways\n")
        with mock.patch.object(cfg, "_run", side_effect=fake_run):
            code, out, err = self.run_cli(
                "--break-glass", "--admin-email", "ops@example.org", "--reason", "lost every admin",
            )
        self.assertEqual(code, 1)
        self.assertIn("break-glass", err)
        # up -d --wait (the last step) never ran: three calls (postgres,
        # bootstrap, break-glass), not four.
        self.assertEqual(len(calls), 3)


# Fake discovery documents: only the fields ./configure reads.
INFOMANIAK = {"issuer": "https://login.infomaniak.com", "scopes_supported": ["openid", "profile", "email", "phone"],
              "claims_supported": ["sub", "email", "groups"], "grant_types_supported": ["authorization_code", "refresh_token"]}
AUTHELIA = {"issuer": "https://id.example.org", "scopes_supported": ["openid", "offline_access", "profile", "email", "groups"]}
NO_SCOPES = {"issuer": "https://id.example.org", "authorization_endpoint": "https://id.example.org/auth"}


class TestScopes(Deploy):
    """The scopes asked of the IdP follow what its discovery offers (invalid_scope)."""

    def external(self, *extra):
        return self.run_cli(
            "--non-interactive", "--origin", "https://chat.example.org", "--tls", "upstream",
            "--idp", "external", "--oidc-issuer", "https://id.example.org",
            "--oidc-console-client-secret", "a", "--oidc-chat-client-secret", "b",
            "--admin-email", "ops@example.org", *extra,
        )

    def test_compute_scopes(self):
        self.assertEqual(cfg.compute_scopes(INFOMANIAK), (["openid", "profile", "email"], ["groups"]))
        self.assertEqual(cfg.compute_scopes(AUTHELIA), (list(cfg.WANTED_SCOPES), []))
        self.assertEqual(cfg.compute_scopes(NO_SCOPES), (list(cfg.WANTED_SCOPES), []))
        self.assertEqual(cfg.compute_scopes(None), (list(cfg.WANTED_SCOPES), []))
        # openid is never dropped, even from a document that forgets it.
        self.assertEqual(cfg.compute_scopes({"scopes_supported": ["email"]}), (["openid", "email"], ["profile", "groups"]))
        # An empty or malformed list says nothing.
        self.assertEqual(cfg.compute_scopes({"scopes_supported": []})[0], list(cfg.WANTED_SCOPES))
        self.assertEqual(cfg.compute_scopes({"scopes_supported": "openid"})[0], list(cfg.WANTED_SCOPES))

    def test_infomaniak_like_drops_groups_for_gateway_and_chat(self):
        self.discovery = INFOMANIAK
        code, out, err = self.external()
        self.assertEqual(code, 0, err)
        env = self.env()
        self.assertEqual(env["OIDC_SCOPES"], "openid profile email")
        self.assertEqual(env["OIDC_SCOPES_JSON"], '["openid","profile","email"]')
        self.assertIn("does not offer the groups scope", out)
        self.assertIn("groups claim", out)

    def test_authelia_like_keeps_groups_and_says_nothing(self):
        self.discovery = AUTHELIA
        code, out, err = self.external()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.env()["OIDC_SCOPES"], "openid profile email groups")
        self.assertEqual(self.env()["OIDC_SCOPES_JSON"], '["openid","profile","email","groups"]')
        self.assertNotIn("does not offer", out)

    def test_no_scopes_supported_keeps_the_default(self):
        self.discovery = NO_SCOPES
        code, out, err = self.external()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.env()["OIDC_SCOPES"], "openid profile email groups")
        self.assertNotIn("does not offer", out)

    def test_unreadable_discovery_keeps_the_default_and_says_so(self):
        code, out, err = self.external()
        self.assertEqual(code, 0, err)
        self.assertEqual(self.env()["OIDC_SCOPES"], "openid profile email groups")
        self.assertIn("could not read the issuer's discovery", out)

    def test_offline_does_not_fetch(self):
        self.discovery = INFOMANIAK
        code, _, err = self.external("--offline")
        self.assertEqual(code, 0, err)
        self.fetch.assert_not_called()
        self.assertEqual(self.env()["OIDC_SCOPES"], "openid profile email groups")

    def test_bundled_authelia_is_unchanged_and_never_fetches(self):
        self.discovery = INFOMANIAK
        code, _, err = self.run_cli("--non-interactive", "--origin", "https://chat.example.org",
                                    "--admin-email", "ops@example.org", "--tls", "internal")
        self.assertEqual(code, 0, err)
        self.fetch.assert_not_called()
        self.assertEqual(self.env()["OIDC_SCOPES"], "openid profile email groups")
        self.assertEqual(self.env()["OIDC_SCOPES_JSON"], '["openid","profile","email","groups"]')

    def test_explicit_scopes_win_and_need_openid(self):
        self.discovery = INFOMANIAK
        code, _, err = self.external("--oidc-scopes", "openid,email,phone")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.env()["OIDC_SCOPES"], "openid email phone")
        self.assertEqual(self.env()["OIDC_SCOPES_JSON"], '["openid","email","phone"]')
        code, _, err = self.external("--oidc-scopes", "profile email")
        self.assertEqual(code, 2)
        self.assertIn("openid", err)

    def test_a_rerun_keeps_a_hand_edited_list_but_a_new_issuer_recomputes(self):
        self.discovery = AUTHELIA
        self.external()
        self.assertEqual(self.run_cli("--set", "OIDC_SCOPES=openid email")[0], 0)
        self.assertEqual(self.env()["OIDC_SCOPES_JSON"], '["openid","email"]', "--set writes the JSON twin")
        self.discovery = INFOMANIAK
        self.external()
        self.assertEqual(self.env()["OIDC_SCOPES"], "openid email")
        self.run_cli("--non-interactive", "--origin", "https://chat.example.org", "--tls", "upstream",
                     "--idp", "external", "--oidc-issuer", "https://login.infomaniak.com")
        self.assertEqual(self.env()["OIDC_SCOPES"], "openid profile email")

    def test_an_old_env_without_scopes_is_worked_out_on_the_next_run(self):
        self.discovery = INFOMANIAK
        self.external()
        self.run_cli("--unset", "OIDC_SCOPES", "OIDC_SCOPES_JSON")
        self.external()
        self.assertEqual(self.env()["OIDC_SCOPES_JSON"], '["openid","profile","email"]')

    def test_check_warns_about_an_unsupported_scope(self):
        self.discovery = AUTHELIA
        self.external()
        self.discovery = INFOMANIAK
        report = cfg.check(self.dir, network=True, probe_host=False)
        self.assertEqual(report.errors, [])
        warning = next(w for w in report.warnings if "does not list the scope" in w)
        self.assertIn("groups", warning)
        self.assertIn("--set OIDC_SCOPES='openid profile email'", warning)

    def test_check_is_clean_when_every_scope_is_offered(self):
        self.discovery = INFOMANIAK
        self.external()
        report = cfg.check(self.dir, network=True, probe_host=False)
        self.assertFalse([w for w in report.warnings if "scope" in w], report.warnings)
        self.assertTrue(any("offers every requested scope" in n for n in report.notes))

    def test_check_with_no_scopes_supported_or_offline_or_bundled(self):
        self.discovery = NO_SCOPES
        self.external()
        report = cfg.check(self.dir, network=True, probe_host=False)
        self.assertTrue(any("scopes not checked" in n for n in report.notes))
        self.fetch.reset_mock()
        cfg.check(self.dir, network=False, probe_host=False)
        self.fetch.assert_not_called()
        self.run_cli("--non-interactive", "--origin", "https://chat.example.org",
                     "--admin-email", "ops@example.org", "--tls", "internal", "--idp", "authelia")
        self.fetch.reset_mock()
        cfg.check(self.dir, network=True, probe_host=False)
        self.fetch.assert_not_called()

    def test_check_flags_a_missing_openid_and_a_diverging_json_twin(self):
        self.external()
        values = self.env()
        values["OIDC_SCOPES"] = "profile email"
        values["OIDC_SCOPES_JSON"] = '["openid"]'
        report = cfg.Report()
        cfg.check_values(values, report)
        self.assertTrue(any("must include openid" in e for e in report.errors))
        self.assertTrue(any("OIDC_SCOPES_JSON" in w for w in report.warnings))

    def test_compose_reads_both_from_env(self):
        compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
        self.assertIn("GATEWAY_OIDC__SCOPES: ${OIDC_SCOPES_JSON:-", compose)
        self.assertIn("OPENID_SCOPES: ${OIDC_SCOPES:-", compose)

    def test_the_bundled_authelia_chat_client_allows_refresh_tokens(self):
        """Scheduled chats refresh a background grant: the chat client needs offline_access and the
        refresh_token grant (and a refresh lifetime that outlasts a week)."""
        text = (ROOT / "authelia" / "configuration.yml").read_text(encoding="utf-8")
        block = text.split("client_id: 'cerea'", 1)[1].split("client_id:", 1)[0]
        self.assertIn("'offline_access'", block)
        self.assertIn("'refresh_token'", block)
        self.assertIn("lifespan: 'chat_background'", block)
        # Consent for the ordinary sign-in is remembered; offline_access is asked for rarely, since
        # Authelia cannot remember a consent that includes it.
        self.assertIn("consent_mode: 'pre-configured'", block)
        self.assertIn("pre_configured_consent_duration:", block)
        lifespans = text.split("chat_background:", 1)[1].split("clients:", 1)[0]
        self.assertIn("refresh_token: '90d'", lifespans)

    def test_compose_passes_the_group_settings_and_chat_secret_to_the_gateway(self):
        compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
        self.assertIn("GATEWAY_OIDC__GROUP_IMPORT: ${OIDC_GROUP_IMPORT:-manual}", compose)
        # `[]`, not empty: a gateway older than the comma-list parsing refuses
        # an empty list setting at start.
        self.assertIn("GATEWAY_OIDC__GROUP_ALLOWLIST: ${OIDC_GROUP_ALLOWLIST:-[]}", compose)
        # `-`, not `:-`: an explicitly empty OIDC_DEFAULT_GROUP turns it off.
        self.assertIn("GATEWAY_OIDC__DEFAULT_GROUP: ${OIDC_DEFAULT_GROUP-users}", compose)
        self.assertIn("GATEWAY_OIDC__CHAT_CLIENT_SECRET: ${OIDC_CHAT_CLIENT_SECRET:-}", compose)

    def test_compose_passes_the_machine_client_and_capability_baselines_to_the_gateway(self):
        """ADR 0096: the gateway matches a machine token's azp/client_id
        against GATEWAY_OIDC__MACHINE_CLIENT_ID, and reads the ACCESS_*
        variables as the default flag new groups are created with (per-group
        toggles on Console > Groups, bulk on/off on Console > Settings) — so
        the kit must pass all three through, or a renamed machine client (a
        GitLab app uid) would never match and a chat-only person's machine
        would pass silently."""
        compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
        start = compose.index("  gateway:")
        gateway = compose[start:]
        for line in (
            "GATEWAY_OIDC__MACHINE_CLIENT_ID: ${OIDC_MACHINE_CLIENT_ID:-opencode-enrollment}",
            "GATEWAY_ACCESS__CODE_AGENTS: ${ACCESS_CODE_AGENTS:-on}",
            "GATEWAY_ACCESS__API_KEYS: ${ACCESS_API_KEYS:-on}",
        ):
            self.assertIn(line, gateway)

    def test_compose_gives_the_migrate_service_the_capability_baselines(self):
        """Migration 0060 folds the capability defaults from the environment
        when the newest oidc_config row does not decide them, so the migrate
        service needs the same ACCESS_* variables the gateway gets — or the
        upgrade would decide every existing group's flags from the gateway's
        built-in defaults instead of the deployment's ACCESS_* answers."""
        compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
        start = compose.index("  migrate:")
        end = compose.index("  gateway:", start)
        migrate = compose[start:end]
        for line in (
            "GATEWAY_ACCESS__CODE_AGENTS: ${ACCESS_CODE_AGENTS:-on}",
            "GATEWAY_ACCESS__API_KEYS: ${ACCESS_API_KEYS:-on}",
        ):
            self.assertIn(line, migrate)

    def test_compose_gives_the_migrate_service_the_join_answers(self):
        """Migration 0058 folds the group answers from the environment when the
        newest oidc_config row does not decide them, so the migrate service
        needs the same join variables the gateway gets — or a deployment that
        runs group mode from the environment alone would get a required manual
        group self-mapped by the migration, reopening the spoof."""
        compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
        start = compose.index("  migrate:")
        end = compose.index("  gateway:", start)
        migrate = compose[start:end]
        for line in (
            "GATEWAY_OIDC__JOIN_MODE: ${OIDC_JOIN_MODE:-open}",
            "GATEWAY_OIDC__REQUIRED_GROUPS: ${OIDC_REQUIRED_GROUPS:-}",
            "GATEWAY_OIDC__GROUP_FALLBACK: ${OIDC_GROUP_FALLBACK:-refuse}",
        ):
            self.assertIn(line, migrate)


class TestIdpCheckDetail(unittest.TestCase):
    def _proc(self, stdout, stderr=""):
        return subprocess.CompletedProcess([], 1, stdout=stdout, stderr=stderr)

    def test_shows_the_failing_lines_not_the_summary(self):
        out = (
            "discovery: issuer 'https://x' (matches OIDC_ISSUER)\n"
            "  device flow: MISSING - no device_authorization_endpoint in discovery\n"
            "  end_session_endpoint: (none published)\n"
            "idp check: FAILED\n"
        )
        detail = cfg.idp_check_detail(self._proc(out))
        self.assertIn("device flow: MISSING", detail)
        self.assertNotIn("matches OIDC_ISSUER", detail)
        self.assertNotEqual(detail, "idp check: FAILED")

    def test_several_failures_are_all_shown(self):
        out = "discovery: issuer 'a' does NOT match OIDC_ISSUER 'b'\n  device flow: MISSING x\nidp check: FAILED\n"
        detail = cfg.idp_check_detail(self._proc(out))
        self.assertIn("does NOT match", detail)
        self.assertIn("MISSING", detail)

    def test_falls_back_to_the_last_line(self):
        self.assertEqual(cfg.idp_check_detail(self._proc("a\nTraceback boom\n")), "Traceback boom")

    def test_falls_back_to_stderr_then_a_question_mark(self):
        self.assertEqual(cfg.idp_check_detail(self._proc("", "oops\n")), "oops")
        self.assertEqual(cfg.idp_check_detail(self._proc("")), "?")


if __name__ == "__main__":
    unittest.main()


class TestExclusiveModes(Deploy):
    """Pystino mode (personal tokens, no shared key) and standalone mode (one
    shared key, no personal tokens) are never mixed (issue #16)."""

    GENERIC = ("--preset", "generic", "--idp", "external", "--oidc-issuer", "https://id.example.org",
               "--oidc-chat-client-secret", "c", "--oidc-console-client-id", "x",
               "--oidc-console-client-secret", "y", "--admin-email", "ops@example.org",
               "--upstream-api-key", "k", "--upstream-base-url", "https://llm.example.org/v1")

    def configure(self, *extra):
        return self.run_cli("--non-interactive", "--origin", "https://chat.example.org",
                            "--admin-email", "ops@example.org", *extra)

    def write_env(self, **changes):
        """A written .env, then hand-edited the way an older install was."""
        self.configure("--tls", "internal")
        values = self.env()
        values.update(changes)
        (self.dir / ".env").write_text(cfg.render(TEMPLATE, values, cfg.HEADER), encoding="utf-8")

    def test_pystino_presets_never_write_a_shared_key(self):
        extra = {"satellite": dict(central_url="https://central.example.org", oidc_chat_client_secret="c")}
        for name, preset in cfg.PRESETS.items():
            if name == "generic":
                continue
            with self.subTest(preset=name):
                v = build(preset=name, **extra.get(name, {})).values
                self.assertFalse(v.get("CHAT_OPENAI_API_KEY"))
                self.assertIn(v.get("CHAT_USE_USER_TOKEN", "true"), ("true",))
                self.assertEqual(cfg.model_mode_problems(v), [])

    def test_a_pystino_preset_drops_a_shared_key_an_older_env_held(self):
        v = build(existing={"CHAT_OPENAI_API_KEY": "sk-old", "CHAT_USE_USER_TOKEN": "false"}).values
        self.assertFalse(v.get("CHAT_OPENAI_API_KEY"))
        self.assertEqual(v.get("CHAT_USE_USER_TOKEN", "true"), "true")

    def test_generic_writes_a_key_with_personal_tokens_off(self):
        v = build(preset="generic", idp="external", oidc_issuer="https://id.example.org",
                  oidc_chat_client_secret="c", upstream_api_key="k",
                  upstream_base_url="https://llm.example.org/v1").values
        self.assertEqual((v["CHAT_OPENAI_API_KEY"], v["CHAT_USE_USER_TOKEN"]), ("k", "false"))
        self.assertEqual(cfg.model_mode_problems(v), [])
        v["CHAT_USE_USER_TOKEN"] = "true"
        self.assertTrue(cfg.model_mode_problems(v))

    def test_a_mix_is_detected(self):
        self.assertTrue(cfg.model_mode_problems({"PYSTINO_PRESET": "team", "CHAT_OPENAI_API_KEY": "k"}))
        self.assertTrue(cfg.model_mode_problems(
            {"PYSTINO_PRESET": "team", "CHAT_OPENAI_API_KEY": "k", "CHAT_USE_USER_TOKEN": "true"}))
        self.assertTrue(cfg.model_mode_problems({"PYSTINO_PRESET": "team", "CHAT_USE_USER_TOKEN": "false"}))
        self.assertTrue(cfg.model_mode_problems({"PYSTINO_PRESET": "generic", "CHAT_USE_USER_TOKEN": "true"}))
        self.assertFalse(cfg.model_mode_problems({"PYSTINO_PRESET": "team"}))

    def test_check_flags_a_mixed_env(self):
        self.write_env(CHAT_OPENAI_API_KEY="sk-old")
        report = cfg.check(self.dir, network=False, probe_host=False)
        self.assertTrue(any("CHAT_OPENAI_API_KEY" in e and "shared key" in e for e in report.errors), report.errors)

    def test_configure_says_so_and_fixes_a_mixed_env(self):
        self.write_env(CHAT_OPENAI_API_KEY="sk-old")
        code, out, err = self.configure("--tls", "internal")
        self.assertEqual(code, 0, err)
        self.assertIn("mixes Pystino mode and standalone mode", out)
        self.assertIn("empty CHAT_OPENAI_API_KEY", out)
        self.assertFalse(self.env().get("CHAT_OPENAI_API_KEY"))
        self.assertEqual(cfg.check(self.dir, network=False, probe_host=False).errors, [])

    def test_configure_offers_the_fix_interactively_and_stops_on_no(self):
        self.write_env(CHAT_OPENAI_API_KEY="sk-old")
        before = (self.dir / ".env").read_text()
        with mock.patch.object(cfg.sys.stdin, "isatty", return_value=True), \
                mock.patch.object(cfg, "interview", side_effect=lambda a, g, e: a), \
                mock.patch("builtins.input", return_value="no"):
            code, out, err = self.run_cli("--tls", "internal")
        self.assertEqual(code, 2)
        self.assertIn("Fix it", out)
        self.assertEqual((self.dir / ".env").read_text(), before)

    def test_a_clean_env_gets_no_mix_notice(self):
        self.configure("--tls", "internal")
        code, out, _ = self.configure("--tls", "internal")
        self.assertEqual(code, 0)
        self.assertNotIn("mixes", out)

    def test_generic_with_personal_tokens_is_fixed_to_off(self):
        self.configure(*self.GENERIC)
        values = self.env()
        values["CHAT_USE_USER_TOKEN"] = "true"
        (self.dir / ".env").write_text(cfg.render(TEMPLATE, values, cfg.HEADER), encoding="utf-8")
        code, out, err = self.run_cli("--non-interactive", "--origin", "https://chat.example.org",
                                      *self.GENERIC[:-2])
        self.assertEqual(code, 0, err)
        self.assertIn("mixes", out)
        self.assertEqual(self.env()["CHAT_USE_USER_TOKEN"], "false")

    def test_set_refuses_to_create_a_mix(self):
        self.configure("--tls", "internal")
        before = (self.dir / ".env").read_text()
        code, _, err = self.run_cli("--set", "CHAT_OPENAI_API_KEY=sk-x")
        self.assertEqual(code, 2)
        self.assertIn("would mix", err)
        self.assertEqual((self.dir / ".env").read_text(), before)
        # ...but a --set that does not add a problem still works.
        self.assertEqual(self.run_cli("--set", "PYSTINO_REGISTRY=local")[0], 0)


class TestJoinMode(unittest.TestCase):
    """ADR 0095: the who-may-jay answers ./configure writes."""

    def test_the_answer_is_written_and_the_rest_stay_neutral(self):
        v = build(idp="external", oidc_issuer="https://id.example.org",
                  oidc_console_client_secret="a", oidc_chat_client_secret="b",
                  join_mode="approval").values
        self.assertEqual(v["OIDC_JOIN_MODE"], "approval")
        # The template's neutral defaults: no groups, refuse — the gateway's
        # own defaults, so the file says nothing the deployment does not do.
        self.assertEqual(v["OIDC_REQUIRED_GROUPS"], "")
        self.assertEqual(v["OIDC_GROUP_FALLBACK"], "refuse")

    def test_group_mode_needs_its_groups(self):
        with self.assertRaisesRegex(cfg.ConfigError, "required-groups"):
            build(idp="external", oidc_issuer="https://id.example.org",
                  oidc_console_client_secret="a", oidc_chat_client_secret="b",
                  join_mode="group")

    def test_group_mode_writes_names_and_fallback(self):
        v = build(idp="external", oidc_issuer="https://id.example.org",
                  oidc_console_client_secret="a", oidc_chat_client_secret="b",
                  join_mode="group", required_groups="staff, ops",
                  group_fallback="approval").values
        self.assertEqual(v["OIDC_JOIN_MODE"], "group")
        self.assertEqual(v["OIDC_REQUIRED_GROUPS"], "staff,ops")
        self.assertEqual(v["OIDC_GROUP_FALLBACK"], "approval")

    def test_a_bogus_mode_is_refused(self):
        with self.assertRaisesRegex(cfg.ConfigError, "join-mode"):
            build(idp="external", oidc_issuer="https://id.example.org",
                  oidc_console_client_secret="a", oidc_chat_client_secret="b",
                  join_mode="sometimes")

    def test_the_bundled_idp_honors_an_explicit_answer(self):
        # The gateway supports every mode for the bundled Authelia too (its
        # strangers cannot exist, but the group gate reads console
        # memberships), so an explicit answer is written for it as well.
        v = build(tls="internal", join_mode="invite").values
        self.assertEqual(v["OIDC_JOIN_MODE"], "invite")


class TestDeviceFlowCheck(unittest.TestCase):
    """The enrollment precondition, checked before the stack is built."""

    def test_missing_endpoint_is_the_problem(self):
        problem = cfg.device_flow_problem(
            {"issuer": "https://id.example.org",
             "grant_types_supported": ["authorization_code", "password"]}
        )
        self.assertIn("device_authorization_endpoint", problem)

    def test_a_grant_list_omitting_device_code_is_the_problem(self):
        problem = cfg.device_flow_problem(
            {"issuer": "https://id.example.org",
             "device_authorization_endpoint": "https://id.example.org/device",
             "grant_types_supported": ["authorization_code", "refresh_token"]}
        )
        self.assertIn("device_code", problem)

    def test_a_complete_discovery_passes(self):
        self.assertIsNone(cfg.device_flow_problem(
            {"issuer": "https://id.example.org",
             "device_authorization_endpoint": "https://id.example.org/device",
             "grant_types_supported": ["authorization_code", cfg.DEVICE_CODE_GRANT]}
        ))

    def test_gitlab_shaped_discovery_is_not_a_problem(self):
        # No device endpoint, the short grant spelling, Doorkeeper's authorize.
        self.assertIsNone(cfg.device_flow_problem(
            {"issuer": "https://gitlab.example.org",
             "authorization_endpoint": "https://gitlab.example.org/oauth/authorize",
             "grant_types_supported": ["authorization_code", "device_code"]}
        ))

    def test_no_endpoint_and_a_foreign_authorize_path_is_a_problem(self):
        self.assertIn("device_authorization_endpoint", cfg.device_flow_problem(
            {"issuer": "https://id.example.org",
             "authorization_endpoint": "https://id.example.org/auth",
             "grant_types_supported": ["device_code"]}
        ))

    def test_the_short_spelling_passes_with_an_advertised_endpoint(self):
        self.assertIsNone(cfg.device_flow_problem(
            {"issuer": "https://id.example.org",
             "device_authorization_endpoint": "https://id.example.org/device",
             "grant_types_supported": ["device_code"]}
        ))

    def test_an_unreachable_issuer_is_not_a_device_problem(self):
        self.assertIsNone(cfg.device_flow_problem(None))
        self.assertIsNone(cfg.device_flow_problem({}))


class TestMachineClientId(Deploy):
    """galopin's client id: asked, followed from the chat client, and checked."""

    EXT = dict(idp="external", oidc_issuer="https://gitlab.example.org",
               oidc_console_client_secret="a", oidc_chat_client_secret="b", agents=True)

    def existing(self, machine, console="old-app", chat="old-app", agents=True):
        v = dict(build(**dict(self.EXT, agents=agents, oidc_console_client_id=console,
                              oidc_chat_client_id=chat, machine_client_id=machine)).values)
        return v

    def rebuild(self, existing, **kw):
        a = answers(**dict(self.EXT, **kw))
        return cfg.build(a, existing, TEMPLATE)

    def test_machine_id_follows_the_replaced_chat_client(self):
        r = self.rebuild(self.existing("old-app"), oidc_console_client_id="new-app",
                         oidc_chat_client_id="new-app")
        self.assertEqual(r.values["OIDC_MACHINE_CLIENT_ID"], "new-app")
        self.assertTrue(any("changed from old-app to new-app, the new chat client id" in n
                            for n in r.notes), r.notes)

    def test_a_console_id_that_changes_alone_does_not_move_the_machine_id_to_the_chat_id(self):
        r = self.rebuild(self.existing("old-console", console="old-console", chat="old-chat"),
                         oidc_console_client_id="new-console", oidc_chat_client_id="old-chat")
        self.assertEqual(r.values["OIDC_MACHINE_CLIENT_ID"], "old-console")
        self.assertFalse([n for n in r.notes if "changed from" in n], r.notes)
        self.assertTrue(any("changed but galopin's did not" in n for n in r.notes), r.notes)

    def test_an_absent_machine_id_counts_as_the_default_for_the_re_enroll_notes(self):
        old = self.existing("opencode-enrollment")
        del old["OIDC_MACHINE_CLIENT_ID"]
        r = self.rebuild(old, oidc_chat_client_id="new-app")
        self.assertTrue(any("changed but galopin's did not (opencode-enrollment)" in n
                            for n in r.notes), r.notes)
        r = self.rebuild(old, machine_client_id="other-app")
        self.assertTrue(any("their tokens name the old client id" in n for n in r.notes), r.notes)

    def test_machine_id_that_was_the_console_client_follows_too(self):
        r = self.rebuild(self.existing("old-console", console="old-console", chat="old-chat"),
                         oidc_console_client_id="new-console", oidc_chat_client_id="new-chat")
        self.assertEqual(r.values["OIDC_MACHINE_CLIENT_ID"], "new-chat")

    def test_a_distinct_machine_id_is_kept_and_the_notes_say_to_re_enroll(self):
        r = self.rebuild(self.existing("galopin-app"), oidc_chat_client_id="new-app")
        self.assertEqual(r.values["OIDC_MACHINE_CLIENT_ID"], "galopin-app")
        self.assertTrue(any("changed but galopin's did not" in n and "must re-enroll" in n
                            for n in r.notes), r.notes)

    def test_a_changed_machine_id_says_the_enrolled_computers_name_the_old_one(self):
        r = self.rebuild(self.existing("old-app"), oidc_chat_client_id="old-app",
                         machine_client_id="flagged")
        self.assertEqual(r.values["OIDC_MACHINE_CLIENT_ID"], "flagged")
        self.assertTrue(any("their tokens name the old client id" in n for n in r.notes), r.notes)

    def test_the_flag_overrides_the_follow_rule(self):
        r = self.rebuild(self.existing("old-app"), oidc_chat_client_id="new-app",
                         oidc_console_client_id="new-app", machine_client_id="flagged")
        self.assertEqual(r.values["OIDC_MACHINE_CLIENT_ID"], "flagged")

    def test_nothing_changes_when_the_client_ids_do_not(self):
        r = self.rebuild(self.existing("old-app"), oidc_chat_client_id="old-app")
        self.assertEqual(r.values["OIDC_MACHINE_CLIENT_ID"], "old-app")
        self.assertFalse([n for n in r.notes if "re-enroll" in n or "follows" in n], r.notes)

    def interview(self, existing, agents, typed="", chat_secret_given=False):
        asked = []
        typed_replies = iter([typed] if isinstance(typed, str) else typed)

        def fake_input(prompt):
            asked.append(prompt)
            if len(asked) > 40:
                raise AssertionError(f"the interview loops on {prompt!r}")
            if "client id" in prompt and "galopin" not in prompt:
                return "new-app"
            return next(typed_replies, "") if "galopin" in prompt else ""

        given = {"share_mode", "origin", "admin_email", "preset", "tls", "idp", "oidc_issuer",
                 "office", "rustfs", "agents", "upstream_base_url", "group_import", "join_mode",
                 "oidc_console_client_secret", "oidc_chat_client_secret"}
        # The secrets are "given", so the client questions are skipped; drop the
        # chat secret from `given` to ask for the chat client.
        if not chat_secret_given:
            given.discard("oidc_chat_client_secret")
        a = answers(**dict(self.EXT, agents=agents))
        with mock.patch("builtins.input", side_effect=fake_input), \
                mock.patch("getpass.getpass", return_value="secret"), \
                mock.patch("builtins.print"):
            result = cfg.interview(a, given, existing)
        return result, asked

    def test_the_prompt_defaults_to_the_new_chat_client_when_it_was_the_same_app(self):
        result, asked = self.interview(self.existing("old-app"), True)
        self.assertTrue(any("galopin client id (a public app: no secret, device flow allowed)" in p
                            for p in asked), asked)
        self.assertEqual(result.machine_client_id, "new-app")

    def test_the_prompt_keeps_a_distinct_id_and_takes_a_typed_one(self):
        result, _ = self.interview(self.existing("galopin-app"), True)
        self.assertEqual(result.machine_client_id, "galopin-app")
        result, _ = self.interview(self.existing("galopin-app"), True, typed="typed-app")
        self.assertEqual(result.machine_client_id, "typed-app")

    def test_the_prompt_is_asked_when_the_chat_secret_came_on_the_command_line(self):
        result, asked = self.interview(self.existing("galopin-app"), True, typed="typed-app",
                                       chat_secret_given=True)
        self.assertTrue(any("galopin client id" in p for p in asked), asked)
        self.assertEqual(result.machine_client_id, "typed-app")

    def test_the_prompt_asks_again_on_a_bad_paste(self):
        result, asked = self.interview(self.existing("galopin-app"), True,
                                       typed=["bad id", "typed-app\\", " typed-app "])
        self.assertEqual(result.machine_client_id, "typed-app")
        self.assertEqual(len([p for p in asked if "galopin client id" in p]), 3, asked)

    def test_the_prompt_is_asked_only_when_agents_are_on(self):
        result, asked = self.interview(self.existing("old-app", agents=False), False)
        self.assertFalse(any("galopin client id" in p for p in asked), asked)
        self.assertIsNone(result.machine_client_id)

    # --- ./configure --check against a fake IdP -------------------------------------

    def setUp(self):
        super().setUp()
        plain = mock.patch.object(cfg, "_ALLOW_PLAIN_HTTP_DEVICE_ENDPOINT", True)
        plain.start()
        self.addCleanup(plain.stop)

    def serve(self, status, payload, headers=None):
        import http.server
        import json as _json
        import threading
        seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                seen.append((self.path, self.rfile.read(int(self.headers["Content-Length"])).decode()))
                body = _json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_address[1], seen

    def serve_garbage(self):
        """A server that answers with something that is not HTTP."""
        import socket
        import threading
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        sock.listen(5)

        def loop():
            while True:
                try:
                    conn, _ = sock.accept()
                except OSError:
                    return
                with conn:
                    conn.recv(65536)
                    conn.sendall(b"this is not http\r\n\r\n")

        threading.Thread(target=loop, daemon=True).start()
        self.addCleanup(sock.close)
        return sock.getsockname()[1]

    def checked(self, port, agents=True):
        self.discovery = {"issuer": "https://gitlab.example.org",
                          "device_authorization_endpoint": f"http://127.0.0.1:{port}/device",
                          "grant_types_supported": [cfg.DEVICE_CODE_GRANT]}
        values = self.existing("b276916cdeadbeef", agents=agents)
        report = cfg.Report()
        cfg.check_machine_client(values, report)
        return report

    def test_check_accepts_a_machine_client_the_idp_knows(self):
        port, seen = self.serve(200, {"device_code": "d", "user_code": "u"})
        report = self.checked(port)
        self.assertEqual((report.errors, report.warnings), ([], []))
        self.assertEqual(seen, [("/device", "client_id=b276916cdeadbeef&scope=openid")])

    def test_check_errors_on_invalid_client(self):
        port, _ = self.serve(401, {"error": "invalid_client"})
        report = self.checked(port)
        self.assertEqual(len(report.errors), 1)
        self.assertIn("galopin's client id b276916c… is refused by https://gitlab.example.org", report.errors[0])
        self.assertIn("./configure --machine-client-id <id>", report.errors[0])

    def test_check_warns_when_the_idp_cannot_be_reached(self):
        import socket
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        report = self.checked(port)
        self.assertEqual(report.errors, [])
        self.assertEqual(len(report.warnings), 1)

    def test_configure_check_runs_the_probe(self):
        port, seen = self.serve(401, {"error": "invalid_client"})
        self.discovery = {"issuer": "https://gitlab.example.org",
                          "device_authorization_endpoint": f"http://127.0.0.1:{port}/device",
                          "grant_types_supported": [cfg.DEVICE_CODE_GRANT]}
        argv = ("--non-interactive", "--origin", "https://chat.example.org", "--admin-email",
                "ops@example.org", "--idp", "external", "--oidc-issuer", "https://gitlab.example.org",
                "--oidc-console-client-secret", "a", "--oidc-chat-client-secret", "b",
                "--machine-client-id", "refused-app")
        self.assertEqual(self.run_cli(*argv)[0], 0)
        report = cfg.check(self.dir, network=True, probe_host=False)
        self.assertEqual(len(report.errors), 1, report.errors)
        self.assertIn("./configure --machine-client-id <id>", report.errors[0])
        self.assertEqual(seen, [("/device", "client_id=refused-app&scope=openid")])
        seen.clear()
        cfg.check(self.dir, network=False, probe_host=False)
        self.assertEqual(seen, [])

    def test_check_refuses_a_device_endpoint_that_is_not_https(self):
        port, seen = self.serve(200, {"device_code": "d"})
        for endpoint in (f"http://127.0.0.1:{port}/device", "file:///etc/passwd", "ftp://127.0.0.1/x"):
            self.discovery = {"issuer": "https://gitlab.example.org",
                              "device_authorization_endpoint": endpoint,
                              "grant_types_supported": [cfg.DEVICE_CODE_GRANT]}
            report = cfg.Report()
            with mock.patch.object(cfg, "_ALLOW_PLAIN_HTTP_DEVICE_ENDPOINT", False):
                cfg.check_machine_client(self.existing("b276916cdeadbeef"), report)
            self.assertEqual(report.errors, [], endpoint)
            self.assertEqual(len(report.warnings), 1, endpoint)
            self.assertIn("not an https:// address", report.warnings[0])
        self.assertEqual(seen, [])

    def test_check_does_not_follow_a_redirect(self):
        other, followed = self.serve(200, {"device_code": "d"})
        port, seen = self.serve(302, {}, {"Location": f"http://127.0.0.1:{other}/steal"})
        report = self.checked(port)
        self.assertEqual(len(seen), 1)
        self.assertEqual(followed, [])
        self.assertEqual(report.errors, [])
        self.assertTrue(any("answered 302" in w for w in report.warnings), report.warnings)

    def test_check_reads_a_bounded_answer(self):
        port, _ = self.serve(200, {"device_code": "d", "padding": "x" * (cfg.DEVICE_RESPONSE_LIMIT * 2)})
        report = self.checked(port)
        self.assertEqual(report.notes, [])
        self.assertEqual(len(report.warnings), 1)

    def test_check_survives_an_answer_that_is_not_http(self):
        report = self.checked(self.serve_garbage())
        self.assertEqual(report.errors, [])
        self.assertEqual(len(report.warnings), 1)

    def test_discovery_survives_an_answer_that_is_not_http(self):
        self.assertIsNone(REAL_FETCH_DISCOVERY(f"http://127.0.0.1:{self.serve_garbage()}", timeout=3))

    def test_check_skips_the_probe_without_agents(self):
        port, seen = self.serve(401, {"error": "invalid_client"})
        report = self.checked(port, agents=False)
        self.assertEqual((report.errors, report.warnings, seen), ([], [], []))

    def test_the_device_endpoint_is_derived_for_gitlab(self):
        self.assertEqual(
            cfg.device_endpoint({"authorization_endpoint": "https://g.example.org/oauth/authorize",
                                 "grant_types_supported": ["device_code"]}),
            "https://g.example.org/oauth/authorize_device")
        self.assertIsNone(cfg.device_endpoint({"authorization_endpoint": "https://i.example.org/auth"}))


class TestEnvSafety(Deploy):
    """Pasted values must never leave a .env that docker compose cannot read."""

    EXT = dict(idp="external", oidc_issuer="https://gitlab.example.org",
               oidc_console_client_secret="a", oidc_chat_client_secret="b")
    ARGV = ("--non-interactive", "--origin", "https://chat.example.org", "--admin-email", "ops@example.org")
    DOCKER_ERR = "failed to read /x/.env: line 617: unterminated quoted value 'gloas-SECRETVALUE"

    def docker_fails(self):
        fake = subprocess.CompletedProcess([], 1, "", self.DOCKER_ERR)
        return mock.patch.object(cfg, "_run", return_value=fake)

    def test_a_secret_with_a_trailing_backslash_is_refused(self):
        with self.assertRaisesRegex(cfg.ConfigError, "ends with a backslash; paste it again without it"):
            build(**dict(self.EXT, oidc_console_client_secret="gloas-abc\\"))

    def test_a_secret_with_inner_spaces_quotes_or_backslashes_is_refused(self):
        for bad in ("gloas abc", "gloas'abc", 'gloas"abc', "gl\toas", "gl\\oas"):
            with self.assertRaises(cfg.ConfigError, msg=bad):
                build(**dict(self.EXT, oidc_chat_client_secret=bad))

    def test_a_secret_and_a_client_id_may_hold_punctuation(self):
        v = build(**dict(self.EXT, oidc_chat_client_secret="p@ss!w%rd?[x]$#&(1)*;<>")).values
        self.assertEqual(v["OIDC_CHAT_CLIENT_SECRET"], "p@ss!w%rd?[x]$#&(1)*;<>")
        for ident in ("a:b@c", "1234@project", "0b8d1f3e-aaaa-4bbb-8ccc-123456789abc", "app.v2_x~y+z=/"):
            v = build(**dict(self.EXT, oidc_chat_client_id=ident, machine_client_id=ident)).values
            self.assertEqual((v["OIDC_CHAT_CLIENT_ID"], v["OIDC_MACHINE_CLIENT_ID"]), (ident, ident))
        for bad in ("app home", "app'home", 'app"home', "app\\home", "x" * (cfg.CREDENTIAL_MAX + 1)):
            with self.assertRaises(cfg.ConfigError, msg=bad):
                build(**dict(self.EXT, oidc_chat_client_id=bad))

    ODD = {"OIDC_CHAT_CLIENT_SECRET": 'has"dq\\mid', "OIDC_CHAT_CLIENT_ID": "1234@proj",
           "OIDC_CONSOLE_CLIENT_SECRET": 'co"nsole secret', "OIDC_MACHINE_CLIENT_ID": "9@machine app"}

    def test_a_value_already_in_the_env_is_not_judged_by_build(self):
        existing = dict(build(**dict(self.EXT)).values, **self.ODD)
        r = cfg.build(answers(**dict(self.EXT, oidc_chat_client_secret=self.ODD["OIDC_CHAT_CLIENT_SECRET"],
                                     oidc_chat_client_id=self.ODD["OIDC_CHAT_CLIENT_ID"],
                                     oidc_console_client_secret=self.ODD["OIDC_CONSOLE_CLIENT_SECRET"],
                                     machine_client_id=self.ODD["OIDC_MACHINE_CLIENT_ID"])),
                      existing, TEMPLATE)
        for key, value in self.ODD.items():
            self.assertEqual(r.values[key], value, key)
        with self.assertRaises(cfg.ConfigError):
            cfg.build(answers(**dict(self.EXT, oidc_chat_client_secret='other"dq')), existing, TEMPLATE)

    def test_keeping_every_default_at_the_prompts_keeps_an_odd_working_env(self):
        existing = dict(build(**dict(self.EXT, agents=True)).values, **self.ODD)
        asked = []

        def fake_input(prompt):
            asked.append(prompt)
            if len(asked) > 40:
                raise AssertionError(f"the interview loops on {prompt!r}")
            return ""

        given = {"share_mode", "origin", "admin_email", "preset", "tls", "idp", "oidc_issuer",
                 "office", "rustfs", "agents", "upstream_base_url", "group_import", "join_mode"}
        a = answers(**dict(self.EXT, agents=True, oidc_console_client_secret=None,
                           oidc_chat_client_secret=None))
        with mock.patch("builtins.input", side_effect=fake_input), \
                mock.patch("getpass.getpass", side_effect=lambda p: ""), \
                mock.patch("builtins.print"):
            a = cfg.interview(a, given, existing)
        self.assertEqual(a.oidc_chat_client_secret, self.ODD["OIDC_CHAT_CLIENT_SECRET"])
        self.assertTrue(any("galopin client id" in p for p in asked), asked)
        r = cfg.build(a, existing, TEMPLATE)
        for key, value in self.ODD.items():
            self.assertEqual(r.values[key], value, key)

    def test_typing_out_the_current_value_is_the_same_as_keeping_it(self):
        odd = 'has"dq\\mid'
        with mock.patch("getpass.getpass", side_effect=[odd]):
            got = cfg.ask("  client secret", odd, secret=True,
                          validate=cfg.credential_validator("client secret"))
        self.assertEqual(got, odd)

    def test_the_charset_error_never_shows_the_characters(self):
        problem = cfg.credential_problem("chat client secret", "SECRETVALUE x'\"\\y")
        self.assertIn("contains a character that is not allowed", problem)
        self.assertNotIn("SECRETVALUE", problem)
        for char in ("'", '"', "\\"):
            self.assertNotIn(char, problem)

    def test_a_kept_default_is_not_judged_again(self):
        odd = "p@ss!w%rd\\"
        with mock.patch("getpass.getpass", side_effect=[""]):
            got = cfg.ask("  client secret", odd, secret=True,
                          validate=cfg.credential_validator("client secret"))
        self.assertEqual(got, odd)

    def test_a_new_secret_with_punctuation_is_taken_at_the_prompt(self):
        with mock.patch("getpass.getpass", side_effect=["  p@ss!w%rd?[x]  "]):
            got = cfg.ask("  client secret", "old", secret=True,
                          validate=cfg.credential_validator("client secret"))
        self.assertEqual(got, "p@ss!w%rd?[x]")

    def test_every_prompt_asks_again_on_an_unsafe_paste(self):
        for bad in ("it's", "line\rbreak", "tail\\", "bell\x07"):
            replies = iter([bad, "fine value"])
            printed = []
            with mock.patch("builtins.input", side_effect=lambda p: next(replies)), \
                    mock.patch("builtins.print", side_effect=lambda *x, **k: printed.append(" ".join(map(str, x)))):
                got = cfg.ask("Its API key", "")
            self.assertEqual(got, "fine value", bad)
            self.assertTrue(printed, bad)
            self.assertNotIn(bad, " ".join(printed))

    def test_surrounding_whitespace_is_stripped_from_a_flag_value(self):
        v = build(**dict(self.EXT, oidc_chat_client_id="  new-app \n")).values
        self.assertEqual(v["OIDC_CHAT_CLIENT_ID"], "new-app")

    def test_quote_refuses_a_value_that_compose_would_misread(self):
        with self.assertRaisesRegex(cfg.ConfigError, "backslash"):
            cfg.quote("X", "abc\\")
        self.assertEqual(cfg.quote("X", "a\\b"), "X='a\\b'")

    def test_the_prompt_strips_pasted_whitespace_and_asks_again_on_a_backslash(self):
        replies = iter(["  gloas-abc\\", "  gloas-abc  "])
        printed = []
        with mock.patch("getpass.getpass", side_effect=lambda p: next(replies)), \
                mock.patch("builtins.print", side_effect=lambda *x, **k: printed.append(" ".join(map(str, x)))):
            got = cfg.ask("  client secret", "", secret=True, validate=cfg.credential_validator("client secret"))
        self.assertEqual(got, "gloas-abc")
        self.assertTrue(any("ends with a backslash" in p and "paste it again" in p for p in printed), printed)

    def test_a_bad_env_line_is_not_echoed(self):
        with self.assertRaises(cfg.ConfigError) as caught:
            cfg.parse_env("A='x'\ngloas-SECRETVALUE\n")
        self.assertIn("line 2", str(caught.exception))
        self.assertNotIn("SECRETVALUE", str(caught.exception))

    def test_the_sanitiser_keeps_line_and_key_and_drops_values(self):
        for raw in (
            "failed to read /srv/cerea/.env: line 618: key cannot contain a space",
            self.DOCKER_ERR,
            "line 9: unexpected character \"x\" in variable name near \"OIDC_X=gloas-SECRETVALUE\"",
        ):
            out = cfg.redact_env_error(raw, ("gloas-SECRETVALUE",))
            self.assertNotIn("SECRETVALUE", out)
            self.assertRegex(out, r"line \d+")
        self.assertIn("key cannot contain a space", cfg.redact_env_error(
            "failed to read /x/.env: line 618: key cannot contain a space"))

    def test_the_sanitiser_keeps_a_path_that_holds_near(self):
        out = cfg.redact_env_error("failed to read /home/near/cerea/.env: line 4: key cannot contain a space")
        self.assertEqual(out, "failed to read /home/near/cerea/.env: line 4: key cannot contain a space")

    def test_the_sanitiser_drops_an_unquoted_value_and_keeps_the_key(self):
        out = cfg.redact_env_error("error: invalid interpolation for OIDC_CHAT_CLIENT_SECRET=gloas-SECRETVALUE in line 12")
        self.assertNotIn("SECRETVALUE", out)
        self.assertIn("OIDC_CHAT_CLIENT_SECRET=…", out)
        self.assertIn("line 12", out)

    def test_the_idp_check_detail_is_not_run_through_the_env_sanitiser(self):
        proc = subprocess.CompletedProcess([], 1, "client 'cerea' does NOT match the audience 'x'\n", "")
        self.assertEqual(cfg.idp_check_detail(proc), "client 'cerea' does NOT match the audience 'x'")

    def test_check_flags_a_backslash_line_without_echoing_the_value(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        path = self.dir / ".env"
        path.write_text(path.read_text() + "OIDC_CONSOLE_CLIENT_SECRET='gloas-SECRETVALUE\\'\n")
        report = cfg.check(self.dir, network=False, probe_host=False)
        joined = " ".join(report.errors)
        self.assertIn("OIDC_CONSOLE_CLIENT_SECRET ends with a backslash", joined)
        self.assertNotIn("SECRETVALUE", joined)

    def test_check_does_not_echo_a_docker_error_value(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        with mock.patch.object(cfg, "compose_version", return_value=(5, 6)), self.docker_fails():
            report = cfg.check(self.dir, network=False, probe_host=True)
        self.assertTrue(any("line 617" in e for e in report.errors), report.errors)
        self.assertNotIn("SECRETVALUE", " ".join(report.errors))

    def files(self):
        return sorted(p.name for p in self.dir.iterdir() if p.name.startswith(".") and p.name != ".env.example")

    def real_check(self):
        return mock.patch.object(cfg, "compose_env_problem", REAL_COMPOSE_ENV_PROBLEM)

    def test_a_write_docker_cannot_read_is_rolled_back(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        before = (self.dir / ".env").read_text()
        with self.real_check(), self.docker_fails():
            code, out, err = self.run_cli("--set", "CHAT_TITLE=Other")
        self.assertEqual(code, 2)
        self.assertEqual((self.dir / ".env").read_text(), before)
        self.assertIn("line 617", err)
        self.assertNotIn("SECRETVALUE", err + out)

    def test_a_rolled_back_set_keeps_the_mode_and_leaves_nothing_behind(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        with self.real_check(), self.docker_fails():
            self.assertEqual(self.run_cli("--set", "CHAT_TITLE=Other")[0], 2)
        self.assertEqual(self.files(), [".env"])
        self.assertEqual(stat.S_IMODE((self.dir / ".env").stat().st_mode), 0o600)

    def test_a_rolled_back_configure_over_an_existing_env_changes_nothing(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        before = (self.dir / ".env").read_text()
        with self.real_check(), self.docker_fails():
            code, out, err = self.run_cli(*self.ARGV, "--link-by-email")
        self.assertEqual(code, 2)
        self.assertEqual((self.dir / ".env").read_text(), before)
        self.assertEqual(self.files(), [".env"])
        self.assertIn("nothing was changed", err)
        self.assertNotIn("SECRETVALUE", err + out)

    def test_a_successful_set_leaves_no_backup(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        self.assertEqual(self.run_cli("--set", "CHAT_TITLE=Other")[0], 0)
        self.assertEqual(self.env()["CHAT_TITLE"], "Other")
        self.assertEqual(self.files(), [".env"])

    def test_a_successful_configure_over_an_existing_env_keeps_one_backup(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        self.assertEqual(self.run_cli(*self.ARGV, "--link-by-email")[0], 0)
        self.assertEqual(len([f for f in self.files() if ".bak-" in f]), 1, self.files())

    def test_the_candidate_is_checked_before_it_replaces_the_env(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        before = (self.dir / ".env").read_text()
        seen = []

        def run(cmd, timeout=30, cwd=None):
            seen.append((cmd, (self.dir / ".env").read_text()))
            return subprocess.CompletedProcess(cmd, 0, "", "")

        with self.real_check(), mock.patch.object(cfg, "_run", side_effect=run):
            self.assertEqual(self.run_cli("--set", "CHAT_TITLE=Other")[0], 0)
        self.assertEqual(len(seen), 1)
        cmd, env_then = seen[0]
        self.assertIn("--env-file", cmd)
        self.assertNotEqual(Path(cmd[cmd.index("--env-file") + 1]).name, ".env")
        self.assertEqual(env_then, before)
        self.assertNotEqual((self.dir / ".env").read_text(), before)

    def test_an_interrupt_while_checking_leaves_the_env_and_no_temp_file(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        before = (self.dir / ".env").read_text()
        with self.real_check(), mock.patch.object(cfg, "_run", side_effect=KeyboardInterrupt):
            code, _, err = self.run_cli("--set", "CHAT_TITLE=Other")
        self.assertEqual(code, 130)
        self.assertIn("interrupted; .env unchanged", err)
        self.assertNotIn("Traceback", err)
        self.assertEqual((self.dir / ".env").read_text(), before)
        self.assertEqual(self.files(), [".env"])

    def test_replacing_the_env_keeps_owner_and_group_access(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        os.chmod(self.dir / ".env", 0o640)
        code, _, err = self.run_cli("--set", "CHAT_TITLE=Other")
        self.assertEqual(code, 0)
        self.assertEqual(stat.S_IMODE((self.dir / ".env").stat().st_mode), 0o640)
        self.assertEqual(err, "")

    def test_a_world_readable_env_is_narrowed_with_a_warning(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        for wide, now in ((0o644, 0o640), (0o666, 0o660), (0o777, 0o660)):
            os.chmod(self.dir / ".env", wide)
            code, _, err = self.run_cli("--set", f"CHAT_TITLE=T{wide}")
            self.assertEqual(code, 0)
            self.assertEqual(stat.S_IMODE((self.dir / ".env").stat().st_mode), now, oct(wide))
            self.assertIn(f"was mode {wide:04o}", err)
            self.assertIn("other users had access", err)
            self.assertNotIn("read", err)

    def test_a_first_write_docker_cannot_read_leaves_no_env(self):
        with self.real_check(), self.docker_fails():
            code, _, err = self.run_cli(*self.ARGV)
        self.assertEqual(code, 2)
        self.assertEqual(self.files(), [])

    def test_set_applies_the_same_charset_as_the_prompt(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        before = (self.dir / ".env").read_text()
        for item in ("OIDC_CHAT_CLIENT_SECRET=a b", "OIDC_CHAT_CLIENT_SECRET=ab\\", "OIDC_CHAT_CLIENT_ID=a b",
                     "OIDC_MACHINE_CLIENT_ID=it's"):
            code, _, err = self.run_cli("--set", item)
            self.assertEqual(code, 2, item)
            self.assertIn("nothing written", err)
            self.assertNotIn(item.split("=", 1)[1], err)
        self.assertEqual((self.dir / ".env").read_text(), before)
        self.assertEqual(self.run_cli("--set", "OIDC_CHAT_CLIENT_SECRET=  p@ss!%?[x]  ")[0], 0)
        self.assertEqual(self.env()["OIDC_CHAT_CLIENT_SECRET"], "p@ss!%?[x]")
        self.assertEqual(self.run_cli("--set", "OIDC_CHAT_CLIENT_ID=1234@proj")[0], 0)
        self.assertEqual(self.env()["OIDC_CHAT_CLIENT_ID"], "1234@proj")

    def test_set_does_not_judge_a_value_the_env_already_holds(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        path = self.dir / ".env"
        path.write_text(path.read_text() + "OIDC_CHAT_CLIENT_SECRET='has\"dq\\mid'\n")
        before = path.read_text()
        code, out, err = self.run_cli("--set", 'OIDC_CHAT_CLIENT_SECRET=has"dq\\mid')
        self.assertEqual((code, err), (0, ""), out)
        self.assertEqual(path.read_text(), before)
        self.assertEqual(self.run_cli("--set", 'OIDC_CHAT_CLIENT_SECRET=other"dq')[0], 2)

    def test_a_value_survives_the_round_trip_through_a_quoted_line(self):
        for value in ('a"b', "a\\b", "a$b", "a #b", 'say "hi" \\n', "p@ss!%?[x]"):
            self.assertEqual(cfg.parse_env(cfg.quote("X", value)), {"X": value}, value)
        self.assertEqual(cfg.parse_env('X="a\\"b"'), {"X": 'a"b'})

    def test_the_problem_is_the_line_that_names_the_syntax_not_a_warning_before_it(self):
        err = ('time="x" level=warning msg="The \\"FOO\\" variable is not set"\n'
               "failed to read /x/.env.new-ab: line 5: key cannot contain a space\n")
        fake = subprocess.CompletedProcess([], 1, "", err)
        with mock.patch.object(cfg, "_run", return_value=fake):
            problem = REAL_COMPOSE_ENV_PROBLEM(self.dir, self.dir / ".env.new-ab")
        self.assertEqual(problem, "failed to read /x/.env.new-ab: line 5: key cannot contain a space")

    def test_check_warns_about_a_left_over_candidate(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        (self.dir / ".env.new-abc123").write_text("X='y'\n")
        report = cfg.check(self.dir, network=False, probe_host=False)
        self.assertTrue(any(".env.new-abc123" in w for w in report.warnings), report.warnings)
        (self.dir / ".env.new-abc123").unlink()
        report = cfg.check(self.dir, network=False, probe_host=False)
        self.assertFalse(any(".env.new-" in w for w in report.warnings), report.warnings)

    def test_the_kit_gitignore_covers_the_candidate(self):
        self.assertIn(".env.new-*", (ROOT / ".gitignore").read_text().splitlines())

    def test_a_malformed_set_item_does_not_echo_the_value(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        for item in ("bad key=gloas-SECRETVALUE", "TOKEN:gloas-SECRETVALUE", "1X=gloas-SECRETVALUE"):
            code, _, err = self.run_cli("--set", item)
            self.assertEqual(code, 2, item)
            self.assertNotIn("SECRETVALUE", err)

    def test_a_symlinked_env_is_replaced_at_its_target(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        elsewhere = Path(tempfile.mkdtemp(prefix="configure-target-"))
        self.addCleanup(shutil.rmtree, elsewhere, True)
        shutil.move(str(self.dir / ".env"), str(elsewhere / "real.env"))
        (self.dir / ".env").symlink_to(elsewhere / "real.env")
        self.assertEqual(self.run_cli("--set", "CHAT_TITLE=Other")[0], 0)
        self.assertTrue((self.dir / ".env").is_symlink())
        self.assertIn("CHAT_TITLE='Other'", (elsewhere / "real.env").read_text())
        self.assertEqual(sorted(p.name for p in elsewhere.iterdir()), ["real.env"])

    def test_a_disk_error_is_one_line_and_changes_nothing(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        before = (self.dir / ".env").read_text()
        real_replace = os.replace

        def final_replace_fails(src, dst, *a, **k):
            # Only the move into place fails: the backup is written with os.replace too.
            if Path(dst).name == ".env":
                raise PermissionError(13, "Permission denied")
            return real_replace(src, dst, *a, **k)

        for argv in (("--set", "CHAT_TITLE=Other"), (*self.ARGV, "--link-by-email")):
            with mock.patch.object(os, "replace", side_effect=final_replace_fails):
                code, _, err = self.run_cli(*argv)
            self.assertEqual(code, 1, argv)
            self.assertEqual(len(err.strip().splitlines()), 1, err)
            self.assertIn("Permission denied", err)
            self.assertEqual((self.dir / ".env").read_text(), before)
            self.assertEqual([f for f in self.files() if "new-" in f or ".bak-" in f], [], argv)

    @property
    def good_env(self):
        return "".join(
            line + "\n" for line in (self.dir / ".env").read_text().splitlines()
            if "CHAT_TITLE" not in line
        )

    LINE_BREAKS = ("\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029")

    def test_a_value_with_a_line_break_character_is_never_written(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        before = (self.dir / ".env").read_text()
        for char in self.LINE_BREAKS:
            with self.assertRaises(cfg.ConfigError, msg=repr(char)):
                cfg.quote("CHAT_TITLE", "a" + char + "b")
            code, _, err = self.run_cli("--set", f"CHAT_TITLE=a{char}b")
            self.assertEqual(code, 2, repr(char))
            self.assertNotIn("Traceback", err)
            self.assertEqual((self.dir / ".env").read_text(), before)
        self.assertEqual(cfg.quote("X", ""), "X=''")

    def test_the_prompt_refuses_the_unicode_line_breaks_too(self):
        for char in ("\x85", "\u2028", "\u2029", "\x0b", "\x1c"):
            self.assertIsNotNone(cfg.paste_problem("a" + char + "b"), repr(char))
        self.assertIsNone(cfg.paste_problem("a b \u00e9 \u4e2d"))

    def test_a_candidate_that_does_not_read_back_is_not_written(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        before = (self.dir / ".env").read_text()
        saved, problem = cfg.write_env_verified(self.dir / ".env", "CHAT_TITLE='a\u2028b'\n", self.dir)
        self.assertIn("cannot read it back", problem)
        self.assertIsNone(saved)
        self.assertEqual((self.dir / ".env").read_text(), before)
        self.assertEqual(self.files(), [".env"])

    def test_an_env_configure_cannot_read_is_one_clear_line(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        path = self.dir / ".env"
        path.write_text(path.read_text() + "CHAT_TITLE='a\u2028b'\n")
        for argv in (("--set", "CHAT_TITLE=x"), self.ARGV, ("--break-glass", "--admin-email", "ops@example.org")):
            code, _, err = self.run_cli(*argv)
            self.assertEqual(code, 2, argv)
            self.assertIn(".env does not parse", err)
            self.assertEqual(len(err.strip().splitlines()), 1, err)
        code, out, _ = self.run_cli("--check", "--offline")
        self.assertEqual(code, 1)
        self.assertIn("U+2028", out)

    def test_main_prints_a_config_error_instead_of_a_traceback(self):
        with mock.patch.object(cfg, "cmd_set", side_effect=cfg.ConfigError("boom")):
            code, _, err = self.run_cli("--set", "A=b")
        self.assertEqual((code, err), (2, "configure: boom\n"))

    def test_a_malformed_set_item_shows_only_a_key_shaped_prefix(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        for item, shown in (("bad key=gloas-SECRETVALUE", None), ("gloas-SECRETVALUE", None),
                            ("chat_erasure_token:gloas-SECRETVALUE", "chat_erasure_token"),
                            ("TOKEN:gloas-SECRETVALUE", None), ("1X=gloas-SECRETVALUE", None),
                            ("x" * 80 + "=gloas-SECRETVALUE", None)):
            code, _, err = self.run_cli("--set", item)
            self.assertEqual(code, 2, item)
            self.assertNotIn("SECRETVALUE", err)
            self.assertNotIn("bad", err)
            self.assertEqual(f"starting '{shown}'" in err, shown is not None, err)

    def test_a_bad_unset_argument_is_not_echoed(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        code, _, err = self.run_cli("--unset", "not a key gloas-SECRETVALUE")
        self.assertEqual(code, 2)
        self.assertNotIn("SECRETVALUE", err)

    def test_only_world_access_is_warned_about_and_special_bits_go_quietly(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        os.chmod(self.dir / ".env", 0o2640)
        code, _, err = self.run_cli("--set", "CHAT_TITLE=Other")
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(stat.S_IMODE((self.dir / ".env").stat().st_mode), 0o640)

    def test_the_wide_mode_warning_waits_for_the_replace(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        os.chmod(self.dir / ".env", 0o644)
        with mock.patch.object(os, "replace", side_effect=PermissionError(13, "Permission denied")):
            code, _, err = self.run_cli("--set", "CHAT_TITLE=Other")
        self.assertEqual(code, 1)
        self.assertNotIn("was mode", err)

    def test_the_backup_is_named_in_full(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        code, out, _ = self.run_cli(*self.ARGV, "--link-by-email")
        self.assertEqual(code, 0)
        backup = next(p for p in self.dir.glob(".env.bak-*"))
        self.assertIn(f"the previous one is {backup}", out)

    def test_check_finds_a_leftover_next_to_a_symlinked_target(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        elsewhere = Path(tempfile.mkdtemp(prefix="configure-target-"))
        self.addCleanup(shutil.rmtree, elsewhere, True)
        shutil.move(str(self.dir / ".env"), str(elsewhere / "real.env"))
        (self.dir / ".env").symlink_to(elsewhere / "real.env")
        (elsewhere / "real.env.new-abc").write_text("X='y'\n")
        report = cfg.check(self.dir, network=False, probe_host=False)
        self.assertTrue(any(str(elsewhere / "real.env.new-abc") in w for w in report.warnings), report.warnings)

    def test_a_break_glass_interrupted_after_the_rewrite_says_so(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        with mock.patch.object(cfg, "_run", side_effect=KeyboardInterrupt):
            code, out, err = self.run_cli("--break-glass", "--admin-email", "ops@example.org")
        self.assertEqual(code, 130)
        backup = next(self.dir.glob(".env.bak-*"))
        self.assertIn(f"interrupted after .env was rewritten; {backup} holds the previous one", err)
        self.assertNotIn("unchanged", err)

    def test_a_break_glass_interrupted_before_the_rewrite_says_unchanged(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        before = (self.dir / ".env").read_text()
        with mock.patch.object(cfg, "_utc_backup", side_effect=KeyboardInterrupt):
            code, _, err = self.run_cli("--break-glass", "--admin-email", "ops@example.org")
        self.assertEqual(code, 130)
        self.assertIn("interrupted; .env unchanged", err)
        self.assertEqual((self.dir / ".env").read_text(), before)

    def test_break_glass_rewrites_a_symlinked_env_at_its_target_and_keeps_group_access(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        elsewhere = Path(tempfile.mkdtemp(prefix="configure-target-"))
        self.addCleanup(shutil.rmtree, elsewhere, True)
        shutil.move(str(self.dir / ".env"), str(elsewhere / "real.env"))
        os.chmod(elsewhere / "real.env", 0o640)
        (self.dir / ".env").symlink_to(elsewhere / "real.env")
        fake = subprocess.CompletedProcess([], 1, "", "boom")
        with mock.patch.object(cfg, "_run", return_value=fake):
            self.run_cli("--break-glass", "--admin-email", "ops@example.org")
        self.assertTrue((self.dir / ".env").is_symlink())
        self.assertEqual(stat.S_IMODE((elsewhere / "real.env").stat().st_mode), 0o640)
        self.assertEqual(len(list(elsewhere.glob("real.env.bak-*"))), 1)
        self.assertEqual(cfg.parse_env((elsewhere / "real.env").read_text())["OIDC_KIND"], "authelia")

    def test_an_undecodable_double_quoted_escape_is_one_line_without_the_value(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        path = self.dir / ".env"
        path.write_text(path.read_text() + 'ZZZ="gloas-SECRETVALUE\\xQ"\n')
        with self.assertRaises(cfg.ConfigError) as caught:
            cfg.parse_env(path.read_text())
        self.assertIn("ZZZ: a backslash escape in double quotes does not decode", str(caught.exception))
        for argv in (("--set", "CHAT_TITLE=x"), self.ARGV, ("--break-glass", "--admin-email", "ops@example.org"),
                     ("--check", "--offline")):
            code, out, err = self.run_cli(*argv)
            self.assertNotEqual(code, 0, argv)
            self.assertNotIn("Traceback", out + err)
            self.assertNotIn("SECRETVALUE", out + err)
            self.assertIn("does not decode", out + err)

    def test_a_env_that_is_not_utf8_is_one_line_without_the_content(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        path = self.dir / ".env"
        path.write_bytes(path.read_bytes() + b"CHAT_TITLE='gloas-SECRETVALUE \xff\xfe'\n")
        for argv in (("--set", "CHAT_TITLE=x"), self.ARGV, ("--break-glass", "--admin-email", "ops@example.org"),
                     ("--check", "--offline")):
            code, out, err = self.run_cli(*argv)
            self.assertNotEqual(code, 0, argv)
            self.assertNotIn("Traceback", out + err)
            self.assertNotIn("SECRETVALUE", out + err)
            self.assertIn(".env is not UTF-8", out + err)

    def test_a_malformed_set_item_shows_a_start_only_when_it_is_a_known_key(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        for item, shown in (("chat_erasure_token:x", "chat_erasure_token"), ("CHAT_ERASURE_TOKEN:x", "CHAT_ERASURE_TOKEN"),
                            ("gloas-SECRETVALUE=", None), ("dGVzdHNlY3JldA==", None),
                            ("token:SECRETVALUE", None), ("ghp_SECRETVALUE:x", None)):
            code, _, err = self.run_cli("--set", item)
            self.assertEqual(code, 2, item)
            self.assertNotIn("SECRETVALUE", err)
            self.assertNotIn("dGVzdHNlY3JldA", err)
            self.assertEqual(f"starting '{shown}'" in err, shown is not None, (item, err))

    def test_check_names_a_line_separator_with_its_line_and_key_not_its_value(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        path = self.dir / ".env"
        for char in self.LINE_BREAKS:
            path.write_text(self.good_env + f"CHAT_TITLE='gloas-SECRETVALUE{char}x'\n#{char}comment\n")
            report = cfg.check(self.dir, network=False, probe_host=False)
            joined = " ".join(report.errors)
            self.assertIn(f"U+{ord(char):04X}", joined, repr(char))
            self.assertIn("(CHAT_TITLE)", joined)
            self.assertNotIn("SECRETVALUE", joined)
            self.assertNotIn("does not parse", joined)

    def test_the_parse_error_message_is_not_mangled_by_the_sanitiser(self):
        self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        path = self.dir / ".env"
        path.write_text(path.read_text() + "not a line gloas-SECRETVALUE\n")
        report = cfg.check(self.dir, network=False, probe_host=False)
        joined = " ".join(report.errors)
        self.assertIn("expected a name followed by an equals sign", joined)
        self.assertNotIn("SECRETVALUE", joined)
        self.assertNotIn("KEY=…", joined)

    def test_a_failure_that_is_not_the_env_syntax_does_not_roll_back(self):
        fake = subprocess.CompletedProcess([], 1, "", "required variable FOO is missing a value")
        with mock.patch.object(cfg, "compose_env_problem", REAL_COMPOSE_ENV_PROBLEM), \
                mock.patch.object(cfg, "_run", return_value=fake):
            self.assertEqual(self.run_cli(*self.ARGV)[0], 0)
        self.assertTrue((self.dir / ".env").exists())

    @unittest.skipUnless(shutil.which("docker"), "docker is not installed")
    def test_a_written_env_parses_with_the_real_docker_compose(self):
        if subprocess.run(["docker", "compose", "version"], capture_output=True).returncode:
            self.skipTest("docker compose is not available")
        argv = self.ARGV + ("--idp", "external", "--oidc-issuer", "https://gitlab.example.org",
                            "--oidc-console-client-secret", "gloas-abc_1", "--oidc-chat-client-secret", "x.y=z/+")
        self.assertEqual(self.run_cli(*argv)[0], 0)
        # Whatever else compose says about this scratch copy, it must read the .env.
        proc = subprocess.run(["docker", "compose", "config", "-q"], capture_output=True, text=True,
                              cwd=self.dir, timeout=60)
        self.assertNotRegex(proc.stderr, r"failed to read|unterminated|key cannot contain")

    @unittest.skipUnless(shutil.which("docker"), "docker is not installed")
    def test_the_real_docker_compose_accepts_the_candidate_by_env_file(self):
        if subprocess.run(["docker", "compose", "version"], capture_output=True).returncode:
            self.skipTest("docker compose is not available")
        argv = self.ARGV + ("--idp", "external", "--oidc-issuer", "https://gitlab.example.org",
                            "--oidc-console-client-secret", "p@ss!%?[x]", "--oidc-chat-client-secret", "x.y=z/+")
        with self.real_check():
            self.assertEqual(self.run_cli(*argv)[0], 0)
        self.assertEqual(self.env()["OIDC_CONSOLE_CLIENT_SECRET"], "p@ss!%?[x]")
        self.assertEqual(self.files(), [".env"])


class TestExtractor(Deploy):
    """./configure --extractor: the document reader's engine and its local image."""

    def make_env(self):
        self.assertEqual(self.run_cli("--non-interactive", "--origin", "https://chat.example.org",
                                      "--admin-email", "ops@example.org")[0], 0)

    def docker_has(self, *images):
        """`docker image inspect` succeeds only for these; `docker images` lists them."""
        def fake(cmd, timeout=30, cwd=None):
            if cmd[:3] == ["docker", "image", "inspect"]:
                return subprocess.CompletedProcess(cmd, 0 if cmd[3] in images else 1, "", "")
            if cmd[:2] == ["docker", "images"]:
                return subprocess.CompletedProcess(cmd, 0, "\n".join(images) + "\n", "")
            return None
        patcher = mock.patch.object(cfg, "_run", side_effect=fake)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_docling_sets_engine_ocr_image_and_limits(self):
        self.make_env()
        image = "local/pystino-redaction:sha-abc1234-docling"
        self.docker_has(image)
        code, out, err = self.run_cli("--non-interactive", "--extractor", "docling")
        self.assertEqual(code, 0, err)
        env = self.env()
        self.assertEqual(env["EXTRACTOR_IMAGE"], image)
        self.assertEqual(env["EXTRACTOR_ENGINE"], "docling")
        self.assertEqual(env["EXTRACTOR_OCR"], "rapidocr")
        self.assertEqual(env["EXTRACTOR_MEM_LIMIT"], cfg.DOCLING_MEM_LIMIT)
        self.assertGreater(int(env["GATEWAY_EXTRACTOR__TIMEOUT_SECONDS"]), int(env["EXTRACTOR_TIMEOUT_SECONDS"]))
        report = cfg.Report()
        cfg.check_values(env, report)
        self.assertEqual(report.errors, [])

    def test_markitdown_ocr_keeps_the_markitdown_engine(self):
        self.make_env()
        self.docker_has("local/pystino-redaction:sha-abc1234-ocr")
        self.assertEqual(self.run_cli("--non-interactive", "--extractor", "markitdown+ocr")[0], 0)
        env = self.env()
        self.assertEqual(env["EXTRACTOR_ENGINE"], "markitdown")
        self.assertEqual(env["EXTRACTOR_OCR"], "rapidocr")
        self.assertEqual(env["EXTRACTOR_MEM_LIMIT"], cfg.OCR_MEM_LIMIT)
        self.assertNotIn("EXTRACTOR_TIMEOUT_SECONDS", env)

    def test_a_missing_image_says_how_to_build_it_and_writes_nothing(self):
        self.make_env()
        before = (self.dir / ".env").read_text()
        self.docker_has()
        code, out, err = self.run_cli("--non-interactive", "--extractor", "docling")
        self.assertEqual(code, 2)
        self.assertIn("dev/build.sh --docling", err)
        self.assertIn("CDLA-Permissive-2.0", err)
        self.assertEqual((self.dir / ".env").read_text(), before)

    def test_an_explicit_image_is_taken_as_given(self):
        self.make_env()
        self.docker_has()
        code, _, err = self.run_cli("--non-interactive", "--extractor", "docling",
                                    "--extractor-image", "registry.example.org/x/pystino-redaction:1-docling")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.env()["EXTRACTOR_IMAGE"], "registry.example.org/x/pystino-redaction:1-docling")

    def test_markitdown_puts_it_all_back(self):
        self.make_env()
        self.docker_has("local/pystino-redaction:sha-abc1234-docling")
        self.run_cli("--non-interactive", "--extractor", "docling")
        self.assertEqual(self.run_cli("--non-interactive", "--extractor", "markitdown")[0], 0)
        env = self.env()
        for key in cfg.EXTRACTOR_KEYS:
            self.assertNotIn(key, env)

    def test_the_default_is_untouched(self):
        self.make_env()
        env = self.env()
        for key in cfg.EXTRACTOR_KEYS:
            self.assertNotIn(key, env)

    def test_a_rerun_without_the_flag_keeps_the_choice(self):
        self.make_env()
        self.docker_has("local/pystino-redaction:sha-abc1234-docling")
        self.run_cli("--non-interactive", "--extractor", "docling")
        self.assertEqual(self.run_cli("--non-interactive")[0], 0)
        self.assertEqual(self.env()["EXTRACTOR_ENGINE"], "docling")

    def labelled(self, label=None, present=True):
        """Make `docker image inspect -f <label>` answer with this label."""
        def fake(cmd, timeout=30, cwd=None):
            if cmd[:3] == ["docker", "image", "inspect"] and present:
                return subprocess.CompletedProcess(cmd, 0, (label or "") + "\n", "")
            return subprocess.CompletedProcess(cmd, 1, "", "")
        patcher = mock.patch.object(cfg, "_run", side_effect=fake)
        patcher.start()
        self.addCleanup(patcher.stop)

    def check(self, values):
        report = cfg.Report()
        cfg.check_extractor(values, report)
        return report

    def test_check_flags_a_variant_engine_on_the_default_image(self):
        self.labelled(present=False)
        r = self.check({"EXTRACTOR_ENGINE": "docling"})
        self.assertTrue(any("dev/build.sh --docling" in e for e in r.errors))
        r = self.check({"EXTRACTOR_OCR": "rapidocr",
                        "EXTRACTOR_IMAGE": "ghcr.io/x/pystino-redaction:1-pattern"})
        self.assertEqual(r.errors, [])  # not on this host, tag says nothing: only a note
        self.labelled("none")
        r = self.check({"EXTRACTOR_OCR": "rapidocr",
                        "EXTRACTOR_IMAGE": "ghcr.io/x/pystino-redaction:1-pattern"})
        self.assertTrue(any("dev/build.sh --ocr" in e for e in r.errors))

    def pull(self, values):
        report = cfg.Report()
        cfg.check_local_pull_policy(values, report)
        return report

    def test_check_warns_about_a_local_image_without_never_policy(self):
        r = self.pull({"EXTRACTOR_IMAGE": "local/pystino-redaction:sha-1-ocr"})
        self.assertEqual(r.errors, [])
        self.assertEqual(len(r.warnings), 1)
        self.assertIn("./configure --set EXTRACTOR_PULL_POLICY=never", r.warnings[0])
        r = self.pull({"PYSTINO_REGISTRY": "local", "CEREA_REGISTRY": "local"})
        for name in ("GATEWAY", "REDACTION", "EXTRACTOR", "CEREA", "DOCUMENTS"):
            self.assertIn(f"{name}_PULL_POLICY=never", r.warnings[0])

    def test_check_is_quiet_when_policies_or_published_images(self):
        self.assertEqual(self.pull({}).warnings, [])
        self.assertEqual(self.pull({"EXTRACTOR_IMAGE": "ghcr.io/x/r:1"}).warnings, [])
        self.assertEqual(self.pull({"EXTRACTOR_IMAGE": "local/r:1-ocr", "EXTRACTOR_PULL_POLICY": "never"}).warnings, [])
        # the extractor follows the redaction policy
        self.assertEqual(self.pull({"REDACTION_IMAGE": "local/r:1-ner", "REDACTION_PULL_POLICY": "never"}).warnings, [])
        self.assertEqual(len(self.pull({"REDACTION_IMAGE": "local/r:1-ner"}).warnings), 1)

    def test_a_mirror_is_judged_by_its_label_not_its_tag(self):
        values = {"EXTRACTOR_ENGINE": "docling", "EXTRACTOR_IMAGE": "registry.example.org/team/reader:1"}
        self.labelled("docling")
        self.assertEqual(self.check(values).errors, [])
        self.labelled("ocr")
        self.assertTrue(self.check(values).errors)
        self.labelled(present=False)
        r = self.check(values)
        self.assertEqual(r.errors, [])
        self.assertTrue(any("cannot check" in n for n in r.notes))

    def test_configure_and_check_agree_on_a_mirror(self):
        self.make_env()
        self.docker_has()  # nothing local: the explicit mirror is taken as given
        mirror = "registry.example.org/team/reader:1"
        self.assertEqual(self.run_cli("--non-interactive", "--extractor", "docling",
                                      "--extractor-image", mirror)[0], 0)
        self.labelled(present=False)
        self.assertEqual(self.check(self.env()).errors, [])

    def test_ocr_gets_a_memory_cap_too(self):
        self.make_env()
        self.docker_has("local/pystino-redaction:sha-abc1234-ocr")
        self.assertEqual(self.run_cli("--non-interactive", "--extractor", "markitdown+ocr")[0], 0)
        self.assertEqual(self.env()["EXTRACTOR_MEM_LIMIT"], cfg.OCR_MEM_LIMIT)

    def test_the_image_flag_needs_the_extractor_flag(self):
        self.make_env()
        code, _, err = self.run_cli("--non-interactive", "--extractor-image", "x")
        self.assertEqual(code, 2)
        self.assertIn("--extractor", err)


class TestShareLinks(Deploy):
    """Artifact share links (ADR 0120): the subdomain or the path, and what each writes."""

    def test_a_fresh_install_gets_the_path_and_the_warning(self):
        result = build()
        values = result.values
        self.assertEqual(values["SHARE_MODE"], "path")
        self.assertEqual(values["ARTIFACT_SHARE_PATH"], "/s")
        self.assertEqual(values["ARTIFACT_SHARE_ORIGIN"], "")
        self.assertEqual(values["SHARE_SITE_ADDRESS"], "")
        warning = [n for n in result.notes if "share links" in n]
        self.assertEqual(len(warning), 1)
        self.assertIn(
            "Public (anyone) links to HTML artifacts would run on this site's own origin, isolated only by the "
            "browser sandbox. A subdomain is safer for public links: it keeps shared pages away from the app's "
            "cookies and makes phishing under your domain harder. Signed-in links always use the path.",
            warning[0],
        )

    def test_subdomain_defaults_to_share_dot_host_in_every_tls_mode(self):
        acme = build(share_mode="subdomain").values
        self.assertEqual(acme["ARTIFACT_SHARE_ORIGIN"], "https://share.chat.example.org")
        self.assertEqual(acme["SHARE_SITE_ADDRESS"], "https://share.chat.example.org")
        # Signed-in links always use the path, so it is kept in subdomain mode too.
        self.assertEqual(acme["ARTIFACT_SHARE_PATH"], "/s")
        internal = build(share_mode="subdomain", tls="internal").values
        self.assertEqual(internal["SHARE_SITE_ADDRESS"], "https://share.chat.example.org")
        # Behind a TLS front the proxy listens on plain HTTP, like the main site.
        upstream = build(share_mode="subdomain", tls="upstream").values
        self.assertEqual(upstream["SITE_ADDRESS"], "http://:80")
        self.assertEqual(upstream["SHARE_SITE_ADDRESS"], "http://share.chat.example.org")
        self.assertEqual(upstream["ARTIFACT_SHARE_ORIGIN"], "https://share.chat.example.org")

    def test_a_subdomain_follows_a_non_default_https_port(self):
        values = build(origin="https://chat.example.org:8443", share_mode="subdomain").values
        self.assertEqual(values["ARTIFACT_SHARE_ORIGIN"], "https://share.chat.example.org:8443")

    def test_the_subdomain_and_the_path_can_be_named(self):
        self.assertEqual(
            build(share_mode="subdomain", share_host="Links.Example.org").values["ARTIFACT_SHARE_ORIGIN"],
            "https://links.example.org",
        )
        self.assertEqual(build(share_mode="path", share_path="shared/").values["ARTIFACT_SHARE_PATH"], "/shared")

    def test_refusals(self):
        for kw in (
            dict(share_mode="subdomain", share_host="chat.example.org"),  # the app's own host
            dict(share_mode="subdomain", share_host="10.0.0.5"),
            dict(share_mode="subdomain", share_host="share"),
            dict(share_mode="path", share_path="/chat"),  # shadows the app
            dict(share_mode="path", share_path="/a b"),
            dict(share_mode="elsewhere"),
        ):
            with self.subTest(kw=kw), self.assertRaises(cfg.ConfigError):
                build(**kw)
        # An IP host has no sibling name to give the share host.
        with self.assertRaises(cfg.ConfigError):
            build(origin="https://10.0.0.5", tls="internal", share_mode="subdomain")

    def test_a_re_run_keeps_the_choice_and_an_upgrade_stays_as_it_was(self):
        sub = dict(build(share_mode="subdomain", share_host="links.example.org").values)
        again = build(existing=sub).values
        self.assertEqual(again["ARTIFACT_SHARE_ORIGIN"], "https://links.example.org")
        self.assertEqual(again["SHARE_MODE"], "subdomain")
        # An .env from before this setting writes nothing: links stay at /chat/s/<token>.
        old = {k: v for k, v in build().values.items() if k not in cfg.SHARE_KEYS}
        kept = build(existing=old).values
        self.assertEqual(kept.get("SHARE_MODE", ""), "")
        self.assertEqual(kept.get("ARTIFACT_SHARE_PATH", ""), "")

    def test_switching_modes_clears_the_other_modes_values(self):
        sub = dict(build(share_mode="subdomain").values)
        path = build(existing=sub, share_mode="path").values
        self.assertEqual((path["ARTIFACT_SHARE_ORIGIN"], path["SHARE_SITE_ADDRESS"]), ("", ""))
        self.assertEqual(path["ARTIFACT_SHARE_PATH"], "/s")

    def test_the_kill_switch(self):
        self.assertEqual(build(sharing=False).values["ARTIFACT_SHARING_ENABLED"], "false")
        off = dict(build(sharing=False).values)
        self.assertEqual(build(existing=off).values["ARTIFACT_SHARING_ENABLED"], "false")
        self.assertEqual(build(existing=off, sharing=True).values["ARTIFACT_SHARING_ENABLED"], "")

    def test_check_flags_an_inconsistent_env_and_warns_about_the_path(self):
        path = cfg.Report()
        cfg.check_values(dict(build().values), path)
        self.assertEqual(path.errors, [])
        self.assertTrue(any("isolated only by the browser sandbox" in w for w in path.warnings))

        sub_values = dict(build(share_mode="subdomain").values)
        ok = cfg.Report()
        cfg.check_values(sub_values, ok)
        self.assertEqual(ok.errors, [])
        self.assertFalse(any("browser sandbox" in w for w in ok.warnings))

        bad = cfg.Report()
        cfg.check_values({**sub_values, "SHARE_SITE_ADDRESS": ""}, bad)
        self.assertTrue(any("SHARE_SITE_ADDRESS" in e for e in bad.errors))
        worse = cfg.Report()
        cfg.check_values({**sub_values, "SHARE_MODE": "everywhere"}, worse)
        self.assertTrue(any("SHARE_MODE" in e for e in worse.errors))

    def test_the_cli_writes_the_subdomain_and_the_compose_passes_it_on(self):
        code, out, err = self.run_cli(
            "--non-interactive", "--origin", "https://chat.example.org", "--admin-email", "ops@example.org",
            "--share-mode", "subdomain", "--offline",
        )
        self.assertEqual(code, 0, err)
        env = cfg.parse_env((self.dir / ".env").read_text(encoding="utf-8"))
        self.assertEqual(env["SHARE_MODE"], "subdomain")
        self.assertEqual(env["ARTIFACT_SHARE_ORIGIN"], "https://share.chat.example.org")
        compose = (self.dir / "compose.yaml").read_text(encoding="utf-8")
        for name in ("SHARE_MODE", "SHARE_SITE_ADDRESS", "SHARE_PATH", "ARTIFACT_SHARE_ORIGIN",
                     "ARTIFACT_SHARE_PATH", "ARTIFACT_SHARING_ENABLED"):
            self.assertIn(name, compose)

    def test_the_cli_prints_the_path_warning(self):
        code, out, err = self.run_cli(
            "--non-interactive", "--origin", "https://chat.example.org", "--admin-email", "ops@example.org",
            "--share-mode", "path", "--offline",
        )
        self.assertEqual(code, 0, err)
        self.assertIn("isolated only by the browser sandbox", out + err)


class TestShareInterview(unittest.TestCase):
    """The interview offers the subdomain first where the app has a DNS name, and the path where it cannot."""

    GIVEN = {"origin", "admin_email", "preset", "tls", "idp", "office", "rustfs", "agents", "upstream_base_url"}

    def ask(self, origin, tls, replies, existing=None, extra=()):
        replies = iter(replies)
        printed = []
        with mock.patch("builtins.input", side_effect=lambda prompt="": next(replies)), \
                mock.patch.object(cfg, "refuse_authelia", return_value=None), \
                mock.patch("builtins.print", side_effect=lambda *x, **k: printed.append(" ".join(map(str, x)))):
            result = cfg.interview(answers(origin=origin, tls=tls), set(self.GIVEN) | set(extra), existing or {})
        return result, printed

    def test_a_dns_name_defaults_to_the_subdomain_and_asks_for_the_host(self):
        result, printed = self.ask("https://chat.example.org", "acme", ["", ""])
        self.assertEqual(result.share_mode, "subdomain")
        self.assertEqual(result.share_host, "share.chat.example.org")
        self.assertTrue(any("Artifact share links" in line for line in printed))

    def test_an_ip_can_only_default_to_the_path(self):
        result, _ = self.ask("https://10.0.0.5", "internal", [""])
        self.assertEqual(result.share_mode, "path")
        self.assertIsNone(result.share_host)

    def test_the_path_can_be_chosen_on_a_dns_name(self):
        result, _ = self.ask("https://chat.example.org", "acme", ["path"])
        self.assertEqual(result.share_mode, "path")

    def test_a_flag_or_an_existing_choice_is_not_asked_again(self):
        # No replies are available: asking would raise StopIteration.
        result, printed = self.ask("https://chat.example.org", "acme", [], extra=("share_mode",))
        self.assertIsNone(result.share_mode)
        result, printed = self.ask("https://chat.example.org", "acme", [], existing={"SHARE_MODE": "path"})
        self.assertFalse(any("Artifact share links" in line for line in printed))
