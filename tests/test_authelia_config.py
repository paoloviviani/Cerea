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
    # Real compose sets this only alongside a non-empty SMTP_HOST
    # (compose.yaml's `${SMTP_HOST:+...}`); set directly here since this test
    # never runs compose.
    "AUTHELIA_NOTIFIER_SMTP_PASSWORD_FILE": "/config/keys/smtp_password",
}


@unittest.skipUnless(shutil.which("docker"), "needs docker")
@unittest.skipUnless(shutil.which("openssl"), "needs openssl")
class AutheliaConfigTests(unittest.TestCase):
    """Every case here mounts the real authelia/ directory read-only, plus a
    throwaway JWKS key and (when SMTP is on) a throwaway SMTP password file
    under a temp /config -- the same two paths configuration.yml's own
    `secret` calls and AUTHELIA_NOTIFIER_SMTP_PASSWORD_FILE name."""

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
        # The password never appears in the rendered text -- it travels only
        # through AUTHELIA_NOTIFIER_SMTP_PASSWORD_FILE, outside the template.
        self.assertNotIn("smtp-test-password", out)

    def test_tls_and_plain_smtp_pick_the_other_two_schemes(self) -> None:
        tls = self._authelia("template", {**BASE_ENV, **SMTP_ENV, "X_PYSTINO_SMTP_SECURITY": "tls"})
        self.assertIn("address: 'submissions://smtp.example.org:587'", tls.stdout)
        plain = self._authelia("template", {**BASE_ENV, **SMTP_ENV, "X_PYSTINO_SMTP_SECURITY": "none"})
        self.assertIn("address: 'smtp://smtp.example.org:587'", plain.stdout)

    def test_validate_config_passes_with_and_without_smtp(self) -> None:
        for label, env in (("without SMTP", BASE_ENV), ("with SMTP", {**BASE_ENV, **SMTP_ENV})):
            with self.subTest(label):
                proc = self._authelia("validate", env)
                self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
                self.assertIn("Configuration parsed and loaded with warnings", proc.stdout)
                self.assertNotIn("errors", proc.stdout)


if __name__ == "__main__":
    unittest.main()
