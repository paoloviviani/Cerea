"""authelia/configuration.yml's own template, rendered and validated by the
real image (ADR 0093 §8.5/§8.6). Standard library only: `python3 -m unittest`.

Two things this covers: the notifier and password_reset branch on
X_PYSTINO_SMTP_HOST (with SMTP the config gets a working self-service reset;
without it, the same file the admin-issued reset has always used), and that
there is no second factor regardless of that branch -- totp and webauthn
explicitly disabled, Duo unconfigured, every client's authorization_policy
(and the default_policy) one_factor. Both are properties of the *rendered*
text, which only Authelia's own template filter produces, so this shells out
to the pinned image rather than re-implementing Go templates in Python.
"""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMAGE = "authelia/authelia:4.39.22"

#: Every secret the template references, so a missing one never masquerades
#: as a totp/webauthn/notifier failure. Not real secrets -- thirty-two
#: repeated characters is exactly as fake as it looks, and never leaves this
#: process.
BASE_ENV = {
    "X_PYSTINO_PUBLIC_ORIGIN": "https://cerea.example.org",
    "X_PYSTINO_COOKIE_DOMAIN": "cerea.example.org",
    "X_PYSTINO_SESSION_SECRET": "a" * 32,
    "X_PYSTINO_HMAC_SECRET": "b" * 32,
    "X_PYSTINO_STORAGE_KEY": "c" * 32,
    "X_PYSTINO_RESET_PASSWORD_JWT_SECRET": "d" * 32,
    "X_PYSTINO_CONSOLE_CLIENT_DIGEST": "$pbkdf2-sha512$310000$c2FsdA$aGFzaA",
    "X_PYSTINO_CHAT_CLIENT_DIGEST": "$pbkdf2-sha512$310000$c2FsdA$aGFzaA",
}
SMTP_ENV = {
    "X_PYSTINO_SMTP_HOST": "smtp.example.org",
    "X_PYSTINO_SMTP_PORT": "587",
    "X_PYSTINO_SMTP_USERNAME": "mailer",
    "X_PYSTINO_SMTP_FROM": "noreply@example.org",
    "X_PYSTINO_SMTP_SECURITY": "starttls",
    "X_PYSTINO_SMTP_HAS_PASSWORD": "true",
}


@unittest.skipUnless(shutil.which("docker"), "needs docker")
@unittest.skipUnless(shutil.which("openssl"), "needs openssl")
class AutheliaConfigTests(unittest.TestCase):
    """Every case here mounts the real authelia/ directory read-only, plus a
    throwaway JWKS key and SMTP password file under a temp /config -- the
    two paths configuration.yml's own `secret` calls name."""

    @classmethod
    def setUpClass(cls) -> None:
        # Pull once, on its own generous timeout, so a cold image cache does
        # not count against each test's 60 s `docker run`.
        subprocess.run(["docker", "pull", "-q", IMAGE], check=True, capture_output=True, timeout=600)

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.config_dir = Path(self.tmp.name)
        keys = self.config_dir / "keys"
        keys.mkdir()
        subprocess.run(
            ["openssl", "genrsa", "-out", str(keys / "jwks.pem"), "2048"],
            check=True, capture_output=True, timeout=30,
        )
        (keys / "smtp_password").write_text("smtp-test-password")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _authelia(self, subcommand: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        args = [
            "docker", "run", "--rm",
            "-v", f"{ROOT / 'authelia'}:/etc/authelia:ro",
            "-v", f"{self.config_dir}:/config",
        ]
        for key, value in env.items():
            args += ["-e", f"{key}={value}"]
        args += [
            IMAGE, "authelia",
            "--config.experimental.filters=template",
            "--config=/etc/authelia/configuration.yml",
            "config", subcommand,
        ]
        return subprocess.run(args, capture_output=True, text=True, timeout=60)

    def test_no_second_factor_regardless_of_smtp(self) -> None:
        for label, env in (("without SMTP", BASE_ENV), ("with SMTP", {**BASE_ENV, **SMTP_ENV})):
            with self.subTest(label):
                proc = self._authelia("template", env)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                out = proc.stdout
                self.assertIn("totp:\n  disable: true", out)
                self.assertIn("webauthn:\n  disable: true", out)
                self.assertNotIn("duo_api:", out)
                self.assertEqual(out.count("authorization_policy: 'one_factor'"), 3)
                self.assertIn("default_policy: 'one_factor'", out)

    def test_without_smtp_uses_the_filesystem_notifier_and_disables_reset(self) -> None:
        out = self._authelia("template", BASE_ENV).stdout
        self.assertIn("filesystem:", out)
        self.assertNotIn("smtp:", out)
        self.assertIn("disable: true", out)

    def test_with_smtp_uses_the_smtp_notifier_and_enables_reset(self) -> None:
        out = self._authelia("template", {**BASE_ENV, **SMTP_ENV}).stdout
        self.assertIn("smtp:", out)
        self.assertIn("address: 'submission://smtp.example.org:587'", out)
        self.assertIn("disable: false", out)
        self.assertNotIn("filesystem:", out)
        # `secret`, the same convention the JWKS key already uses: read from
        # the file bootstrap wrote, substituted into the render like any
        # other secret value here -- never a plaintext env-var interpolation.
        # A block scalar, not a quoted one (see the hostile-value test
        # below for why), so the value is on its own, indented line.
        self.assertIn("password: |2-\n      smtp-test-password", out)

    @unittest.skipUnless(importlib.util.find_spec("yaml"), "needs PyYAML")
    def test_a_hostile_password_survives_intact(self) -> None:
        """msquote wraps a value in quotes without escaping one already
        inside it -- a password can hold any character (unlike the SMTP
        fields, which ./configure can and does refuse if they would break
        this file), so quoting has to actually be safe rather than merely
        usually safe. Render it, then parse the result as YAML and check
        the one value round-trips exactly, rather than just looking for
        the right substring in the text."""
        hostile = " p'\"#: w0rd"
        (self.config_dir / "keys" / "smtp_password").write_text(hostile)
        out = self._authelia("template", {**BASE_ENV, **SMTP_ENV}).stdout

        import yaml

        rendered = "\n".join(
            line for line in out.splitlines() if not line.startswith(("---", "##"))
        )
        parsed = yaml.safe_load(rendered)
        self.assertEqual(parsed["notifier"]["smtp"]["password"], hostile)

    def test_smtp_with_no_password_configured_renders_without_one(self) -> None:
        """./configure never requires SMTP_PASSWORD alongside SMTP_HOST -- an
        unauthenticated relay on a private network is a real, supported
        shape, and bootstrap never writes the file `secret` would read for
        it, so this has to render without erroring."""
        env = {**BASE_ENV, **SMTP_ENV}
        del env["X_PYSTINO_SMTP_HAS_PASSWORD"]
        proc = self._authelia("template", env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("smtp:", proc.stdout)
        # Not "password:" alone -- authentication_backend.file's own password
        # mapping (algorithm, argon2, ...) always has one of those, unrelated
        # to the notifier. A scalar value is what the notifier would have had.
        self.assertNotIn("password: '", proc.stdout)

    def test_tls_and_plain_smtp_pick_the_other_two_schemes(self) -> None:
        tls = self._authelia("template", {**BASE_ENV, **SMTP_ENV, "X_PYSTINO_SMTP_SECURITY": "tls"})
        self.assertIn("address: 'submissions://smtp.example.org:587'", tls.stdout)
        self.assertIn("disable_starttls: false", tls.stdout)
        plain = self._authelia("template", {**BASE_ENV, **SMTP_ENV, "X_PYSTINO_SMTP_SECURITY": "none"})
        self.assertIn("address: 'smtp://smtp.example.org:587'", plain.stdout)
        # The scheme alone still enforces STARTTLS by Authelia's own default
        # (found live): "none" needs this too, or it isn't none.
        self.assertIn("disable_starttls: true", plain.stdout)

    def test_validate_config_passes_with_and_without_smtp(self) -> None:
        for label, env in (("without SMTP", BASE_ENV), ("with SMTP", {**BASE_ENV, **SMTP_ENV})):
            with self.subTest(label):
                proc = self._authelia("validate", env)
                self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
                self.assertIn("Configuration parsed and loaded with warnings", proc.stdout)
                self.assertNotIn("errors", proc.stdout)
    def test_rendered_config_serves_the_brand_assets_and_follows_the_browser_theme(self) -> None:
        proc = self._authelia("template", BASE_ENV)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("asset_path: '/etc/authelia/assets'", proc.stdout)
        self.assertIn("theme: 'auto'", proc.stdout)


class AutheliaBrandTests(unittest.TestCase):
    """The sign-in page's look: Authelia's own asset overrides (logo, favicon)
    plus the stylesheet the proxy appends. Nothing here needs docker; the
    asset directory loading is exercised by the validate test above, which
    mounts the whole authelia/ directory."""

    def test_logo_is_a_png_and_favicon_an_icon(self) -> None:
        logo = (ROOT / "authelia" / "assets" / "logo.png").read_bytes()
        self.assertEqual(logo[:8], b"\x89PNG\r\n\x1a\n")
        favicon = (ROOT / "authelia" / "assets" / "favicon.ico").read_bytes()
        self.assertEqual(favicon[:4], b"\x00\x00\x01\x00")

    def test_proxy_appends_the_brand_stylesheet_to_authelias_own(self) -> None:
        caddyfile = (ROOT / "caddy" / "Caddyfile").read_text()
        self.assertIn("handle /authelia/static/css/*", caddyfile)
        self.assertIn('include "authelia-brand.css"', caddyfile)
        # The stock file is fetched through the mirror route, which must exist
        # and must come before the catch-all /authelia/* proxy.
        self.assertLess(caddyfile.index("handle /authelia-src/*"), caddyfile.index("handle /authelia/*"))
        self.assertLess(
            caddyfile.index("handle /authelia/static/css/*"), caddyfile.index("handle /authelia/*")
        )
        self.assertTrue((ROOT / "caddy" / "authelia-brand.css").is_file())

    def test_brand_stylesheet_sets_sentence_case_and_both_themes(self) -> None:
        css = (ROOT / "caddy" / "authelia-brand.css").read_text()
        self.assertIn("text-transform: none", css)
        self.assertIn('[data-theme="dark"]', css)
        self.assertIn('[data-theme="light"]', css)


if __name__ == "__main__":
    unittest.main()
