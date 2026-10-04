#!/usr/bin/env python3
"""Digest a `go test -v` log for the opencode pipeline.

    gotest_report.py LOG EXIT_CODE VERSION LABEL OUT_DIR

Writes OUT_DIR/result.json and OUT_DIR/summary.md and appends the summary to
$GITHUB_STEP_SUMMARY when set. Counts top-level tests only (subtests are
listed under their parent). A test that skipped on its gate or because a tool
is missing ("set GALOPIN_..._IT=1", "... not on PATH") is a *gate skip*: in
this pipeline that means the real-opencode suite did not really run, so it is
reported separately and makes the run fail.
"""
import json
import os
import re
import sys

log_path, exit_code, version, label, out_dir = sys.argv[1:6]
exit_code = int(exit_code)
os.makedirs(out_dir, exist_ok=True)

RUN = re.compile(r"^=== (?:RUN|CONT|NAME)\s+(\S+)")
RESULT = re.compile(r"^(\s*)--- (PASS|FAIL|SKIP): (\S+) \(([\d.]+)s\)")
GATE = re.compile(r"set GALOPIN_\w+=1 to run|not on PATH")

passed, failed, skipped, gate_skipped = [], [], [], []
fail_sub = {}
out = {}      # test name -> its output lines (streamed before its result line)
trailing = None  # test whose header was just seen: -v prints its log after it
current = None
suite_ran = os.path.exists(log_path)
lines = open(log_path, errors="replace").read().splitlines() if suite_ran else []
for line in lines:
    m = RUN.match(line)
    if m:
        current = m.group(1)
        trailing = None
        continue
    m = RESULT.match(line)
    if m:
        indent, status, name, _ = m.groups()
        trailing = name
        if indent:  # subtest: only failures matter, filed under the parent
            if status == "FAIL":
                fail_sub.setdefault(name.split("/")[0], []).append(name)
            continue
        if status == "PASS":
            passed.append(name)
        elif status == "FAIL":
            failed.append(name)
        else:
            skipped.append(name)
            if GATE.search("\n".join(out.get(name, []))):
                gate_skipped.append(name)
        continue
    if line.startswith(("ok ", "FAIL", "PASS", "?", "exit status", "panic:", "goroutine")) and not line.startswith("    "):
        trailing = None
        if line.startswith("panic:"):
            out.setdefault("(panic)", []).append(line)
        continue
    if line.startswith("    ") or line.startswith("\t"):
        key = trailing or current
        if key:
            out.setdefault(key, []).append(line.strip())
        # a skip reason is logged after the header on some Go versions
        if trailing and GATE.search(line) and trailing in skipped and trailing not in gate_skipped:
            gate_skipped.append(trailing)

# first failure: the failing test's own output; else whatever killed the run
first = ""
if failed:
    first_name = failed[0]
    msg = [l[:300] for l in out.get(first_name, []) if not l.startswith("---")]
    if not msg:  # the failure was logged by a subtest
        for sub in fail_sub.get(first_name, []):
            msg += [l[:300] for l in out.get(sub, []) if not l.startswith("---")]
    first = f"{first_name}: " + "\n".join(msg[-12:])
elif not suite_ran:
    first = "the suite did not run: the opencode install or the setup before it failed (see the run log)"
elif exit_code != 0:
    first = "go test exited %d before reporting a failing test:\n" % exit_code + "\n".join(l[:300] for l in lines[-25:])

# a package-level timeout or build failure has no `--- FAIL` line
failing = list(failed)
if exit_code != 0 and not failed:
    failing = ["(no failing test reported: setup failure, build error, panic or timeout)"]

ok = exit_code == 0 and not gate_skipped and (passed or failed)
result = {
    "label": label,
    "version": version,
    "ok": bool(ok),
    "exit_code": exit_code,
    "passed": len(passed),
    "failed": len(failed),
    "skipped": len(skipped),
    "gate_skipped": gate_skipped,
    "failing": failing,
    "failing_subtests": fail_sub,
    "first_failure": first,
}
json.dump(result, open(os.path.join(out_dir, "result.json"), "w"), indent=2)

md = [f"### {label}: opencode {version}: {'PASS' if ok else 'FAIL'}", "",
      f"- passed {len(passed)}, failed {len(failed)}, skipped {len(skipped)} (top-level tests; `go test` exit {exit_code})"]
if gate_skipped:
    md.append(f"- **{len(gate_skipped)} real-opencode tests were gate-skipped** (env var or tool missing), so this run did not cover them: " + ", ".join(f"`{n}`" for n in gate_skipped))
if skipped and len(skipped) != len(gate_skipped):
    md.append("- other skips: " + ", ".join(f"`{n}`" for n in skipped if n not in gate_skipped))
if failing:
    md += ["", "Failing tests:"] + [f"- `{n}`" + (" (subtests: " + ", ".join(fail_sub[n]) + ")" if n in fail_sub else "") for n in failing]
if first:
    md += ["", "First failure:", "```", first[:3000], "```"]
text = "\n".join(md) + "\n"
open(os.path.join(out_dir, "summary.md"), "w").write(text)
if os.environ.get("GITHUB_STEP_SUMMARY"):
    open(os.environ["GITHUB_STEP_SUMMARY"], "a").write(text)
print(text)
sys.exit(0)
