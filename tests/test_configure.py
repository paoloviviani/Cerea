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
        # No test reaches a real issuer; one that needs a discovery document
        # sets `self.discovery`.
        self.discovery = None
        patcher = mock.patch.object(cfg, "fetch_discovery", side_effect=lambda issuer, *a, **k: self.discovery)
        self.fetch = patcher.start()
        self.addCleanup(patcher.stop)

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

    def test_terminal_switch_needs_agents(self):
        self.assertEqual(build(agents=True, terminal=True).values["CODE_TERMINAL_ENABLED"], "true")
        self.assertEqual(build(agents=True).values["CODE_TERMINAL_ENABLED"], "")
        # No agent machines, no terminal, whatever was asked.
        self.assertEqual(build(terminal=True).values["CODE_TERMINAL_ENABLED"], "")
        # A re-run keeps it, and --no-agents turns it off with them.
        first = dict(build(agents=True, terminal=True).values)
        self.assertEqual(build(existing=first).values["CODE_TERMINAL_ENABLED"], "true")
        self.assertEqual(build(existing=first, agents=False).values["CODE_TERMINAL_ENABLED"], "")

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

    def test_needs_reason_and_admin_email(self):
        self.configure()
        code, _, err = self.run_cli("--break-glass", "--admin-email", "ops@example.org")
        self.assertEqual(code, 2)
        self.assertIn("--reason", err)
        code, _, err = self.run_cli("--break-glass", "--reason", "x")
        self.assertEqual(code, 2)
        self.assertIn("--admin-email", err)

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


if __name__ == "__main__":
    unittest.main()
