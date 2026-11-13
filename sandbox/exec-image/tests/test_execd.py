"""The exec daemon's interpreter and its client, with the standard library only.

Runs on any Python 3.10+ (the CI job uses the runner's); the sandbox image runs 3.13.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
TMP = tempfile.mkdtemp(prefix="execd-test-")
os.environ.update(
    EXECD_OUTPUT_ROOT=os.path.join(TMP, "output"),
    EXECD_MOUNT_ROOT=os.path.join(TMP, "data"),
    EXECD_CWD=TMP,
    EXECD_SOCKET=os.path.join(TMP, "execd.sock"),
    EXECD_PIDFILE=os.path.join(TMP, "execd.pid"),
    EXECD_CLIENT_GRACE="2",
)
sys.path.insert(0, str(HERE))
import execd  # noqa: E402

STUB_FIGURES = '''
calls = []
def begin(import_matplotlib):
    calls.append(("begin", import_matplotlib))
    import os
    with open(os.path.join(%r, "figure-1.png"), "wb") as f:
        f.write(b"\\x89PNG-stub")
def sweep():
    calls.append(("sweep",))
''' % os.environ["EXECD_OUTPUT_ROOT"]


class Interpreter(unittest.TestCase):
    def setUp(self):
        self.i = execd.Interpreter()

    def test_stdout_stderr_and_the_last_expression(self):
        r = self.i.run("import sys\nprint('hi')\nsys.stderr.write('warn')\n6 * 7", 10)
        self.assertEqual((r["ok"], r["stdout"], r["stderr"], r["result"]), (True, "hi\n", "warn", "42"))

    def test_a_trailing_semicolon_silences_the_value_and_none_has_no_result(self):
        self.assertIsNone(self.i.run("1 + 1;", 10)["result"])
        self.assertIsNone(self.i.run("x = 3", 10)["result"])
        self.assertEqual(self.i.run("'abc'", 10)["result"], "abc")
        self.assertEqual(self.i.run("[1, 'a']", 10)["result"], "[1, 'a']")

    def test_state_persists_between_runs(self):
        self.i.run("import math\nx = 41", 10)
        self.assertEqual(self.i.run("math.floor(x + 1.5)", 10)["result"], "42")

    def test_an_error_is_a_traceback_of_the_users_code_only(self):
        r = self.i.run("def f():\n    return 1 / 0\nf()", 10)
        self.assertFalse(r["ok"])
        self.assertIn("ZeroDivisionError", r["error"])
        self.assertIn('File "<exec>"', r["error"])
        self.assertNotIn("execd.py", r["error"])
        self.assertIsNone(r["result"])

    def test_a_syntax_error_is_reported_not_raised(self):
        r = self.i.run("def (:", 10)
        self.assertFalse(r["ok"])
        self.assertIn("SyntaxError", r["error"])

    def test_a_clean_system_exit_is_a_success_and_a_failing_one_is_not(self):
        self.assertTrue(self.i.run("import sys\nsys.exit(0)", 10)["ok"])
        self.assertTrue(self.i.run("raise SystemExit", 10)["ok"])
        self.assertFalse(self.i.run("import sys\nsys.exit(2)", 10)["ok"])

    def test_output_is_clamped_like_the_browsers(self):
        r = self.i.run("print('x' * 20000)", 10)
        self.assertLessEqual(len(r["stdout"]), execd.MAX_OUTPUT_CHARS)
        self.assertTrue(r["stdout"].endswith("… [output truncated]"))

    def test_a_run_past_its_limit_is_stopped_and_the_state_is_lost(self):
        self.i.run("kept = 1", 10)
        r = self.i.run("while True:\n    pass", 1)
        self.assertFalse(r["ok"])
        self.assertEqual(r["timeout"]["seconds"], 1)
        self.assertEqual(self.i.run("'kept' in globals()", 10)["result"], "False")

    def test_the_timeout_cannot_be_swallowed(self):
        r = self.i.run("while True:\n    try:\n        pass\n    except Exception:\n        pass", 1)
        self.assertIsNotNone(r["timeout"])

    def test_files_written_to_the_output_folder_are_listed_once(self):
        out = os.environ["EXECD_OUTPUT_ROOT"]
        r = self.i.run(f"open({out!r} + '/a.txt', 'w').write('hello')", 10)
        self.assertEqual([f["path"] for f in r["files"]], [out + "/a.txt"])
        self.assertEqual(r["files"][0]["size"], 5)
        # Unchanged files are not reported again; a rewrite is.
        self.assertEqual(self.i.run("1", 10)["files"], [])
        r2 = self.i.run(f"open({out!r} + '/a.txt', 'w').write('hello!!')", 10)
        self.assertEqual(len(r2["files"]), 1)

    def test_the_figures_module_is_loaded_once_and_called_around_each_run(self):
        self.i.run("import matplotlib\n1", 10, STUB_FIGURES)  # noqa
        self.i.run("2", 10, STUB_FIGURES)
        calls = self.i.figures.calls
        self.assertEqual(calls[0], ("begin", True))
        self.assertEqual(calls[1], ("sweep",))
        self.assertEqual(calls[2], ("begin", False))
        r = self.i.run("3", 10, STUB_FIGURES)
        self.assertTrue(any(f["path"].endswith("figure-1.png") for f in r["files"]))

    def test_a_broken_figures_module_never_fails_a_run(self):
        r = self.i.run("5", 10, "raise RuntimeError('bad')")
        self.assertEqual((r["ok"], r["result"]), (True, "5"))


class Client(unittest.TestCase):
    """run.py starts the daemon on the first call and the state lives on in it."""

    def call(self, code: str, timeout: int = 10) -> dict:
        proc = subprocess.run(
            [sys.executable, str(HERE / "run.py")],
            input=json.dumps({"code": code, "timeout": timeout}).encode(),
            capture_output=True,
            timeout=60,
            env=os.environ,
        )
        return json.loads(proc.stdout.decode().strip().splitlines()[-1])

    @classmethod
    def tearDownClass(cls):
        sock = os.environ["EXECD_SOCKET"]
        # Stop the daemon the test started.
        subprocess.run(["pkill", "-f", f"{HERE}/execd.py serve"], check=False)
        if os.path.exists(sock):
            os.unlink(sock)

    def test_two_calls_share_one_interpreter(self):
        self.assertEqual(self.call("counter = 10")["ok"], True)
        self.assertEqual(self.call("counter += 5\ncounter")["result"], "15")

    def test_a_timeout_replaces_the_interpreter_not_just_its_namespace(self):
        self.call("import json\njson.marker = 1\nkept = 1")
        stopped = self.call("while True:\n    pass", timeout=1)
        self.assertEqual(stopped["timeout"]["seconds"], 1)
        time.sleep(0.5)  # the daemon re-executes itself after answering
        # A new process: neither the namespace nor a change made to a module survives.
        self.assertEqual(self.call("('kept' in globals(), hasattr(__import__('json'), 'marker'))")["result"], "(False, False)")

    def test_a_c_call_that_holds_the_gil_is_killed_by_the_client(self):
        """Neither SIGALRM nor the watchdog thread can run inside sum(range(10**13)); run.py's deadline
        kills the daemon's process group, and the next call starts a fresh one."""
        self.call("survivor = 1")
        started = time.monotonic()
        r = self.call("sum(range(10**13))", timeout=1)
        self.assertEqual(r["timeout"]["seconds"], 1)
        self.assertLess(time.monotonic() - started, 30)
        pid = int(Path(os.environ["EXECD_PIDFILE"]).read_text()) if Path(os.environ["EXECD_PIDFILE"]).exists() else None
        self.assertIsNone(pid, "the pidfile of the killed daemon is gone")
        again = self.call("'survivor' in globals()")
        self.assertEqual(again["result"], "False")

    def test_a_run_past_its_limit_answers_with_the_timeout_shape(self):
        r = self.call("import time\ntime.sleep(30)", timeout=1)
        self.assertEqual(r["timeout"]["seconds"], 1)


if __name__ == "__main__":
    unittest.main()
