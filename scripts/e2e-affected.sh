#!/usr/bin/env bash
# Run the e2e specs a change is likely to affect.
#
#   scripts/e2e-affected.sh --list      print the specs, run nothing
#   scripts/e2e-affected.sh             build (unless E2E_SKIP_BUILD=1) and run them
#   scripts/e2e-affected.sh --base REF  diff against REF instead of origin/main
#
# The specs are chosen from `git diff --name-only <base>...HEAD` plus the
# working tree: a changed spec runs; a changed source file runs the specs
# whose file name shares a feature word with it (src/lib/components/code/
# TerminalPane.svelte -> tests/code-terminal*.spec.ts), and the specs that
# mention the changed file's basename or its route directory. A change to
# shared harness code (tests/fixtures.ts, playwright.config.ts, package*.json)
# selects the @smoke subset. A heuristic, not a proof: CI's e2e-full is the gate.
#
# Runs under `flock /tmp/heavy.lock` (the box's heavy-job lock) unless
# E2E_AFFECTED_NO_LOCK=1 or the caller already holds a lock. Set LOCK_FILE to
# use another slot (e.g. /tmp/heavy.lock.a). E2E_* variables pass through.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
base=origin/main
list=0
while [ $# -gt 0 ]; do
	case "$1" in
	--list) list=1 ;;
	--base) base="$2"; shift ;;
	-h | --help) sed -n '2,19p' "$0"; exit 0 ;;
	*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
	shift
done

changed="$( { git diff --name-only "$base"...HEAD; git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u)"
[ -n "$changed" ] || { echo "No changes against $base." >&2; exit 0; }

# The selection itself is in Python (thousands of word comparisons: too slow in shell).
selection="$(CHANGED="$changed" python3 - <<'PY'
import glob, os, re
STOP = set("src lib server components routes stores utils types api index page layout svelte ts js test tests spec the and chat app common shared handler handlers".split())
def words(path):
    name = re.sub(r"\.(svelte|ts|js|mjs|json|css|spec)", "", path)
    name = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name).lower()
    return {w for w in re.split(r"[^a-z0-9]+", name) if len(w) >= 3 and w not in STOP}
specs = sorted(glob.glob("tests/*.spec.ts"))
swords = {s: words(os.path.basename(s)) for s in specs}
text = {s: open(s, encoding="utf-8").read().lower() for s in specs}
picked, smoke = [], False
def add(s):
    if s not in picked: picked.append(s)
for f in os.environ["CHANGED"].splitlines():
    if f.startswith("tests/") and f.endswith(".spec.ts"):
        if os.path.exists(f): add(f)
    elif f in ("playwright.config.ts", "package.json", "package-lock.json") or re.match(r"tests/(fixtures\.ts|.*Harness\.ts|mock-.*\.ts|fake-machine\.ts)$", f):
        smoke = True
    elif re.match(r"(src|messages|agent)/", f):
        stem = os.path.basename(f).split(".")[0].lower()
        # The file's own name first (TerminalPane -> *terminal*); only when no spec
        # matches it, the directories it lives in (components/code/ -> code-*).
        hits = [s for s in specs if words(os.path.basename(f)) & swords[s] or (len(stem) >= 6 and stem in text[s])]
        if not hits:
            hits = [s for s in specs if words(f) & swords[s]]
        for s in hits:
            add(s)
print("SMOKE=%d" % smoke)
for s in picked: print(s)
PY
)"
smoke="$(head -1 <<<"$selection" | cut -d= -f2)"
specs=()
while IFS= read -r s; do [ -n "$s" ] && specs+=("$s"); done < <(tail -n +2 <<<"$selection")

if [ "${#specs[@]}" -eq 0 ]; then
	if [ "$smoke" = 1 ] || grep -qE '^(src|messages|agent)/' <<<"$changed"; then
		echo "No spec matched by name; falling back to the @smoke subset." >&2
		run_args=(--grep @smoke)
		label="@smoke subset"
	else
		echo "No e2e spec is affected by this change." >&2
		exit 0
	fi
else
	[ "$smoke" = 1 ] && echo "Harness changed: also running the @smoke subset." >&2
	run_args=("${specs[@]}")
	label="${#specs[@]} spec(s)"
fi

if [ "$list" = 1 ]; then
	if [ "${run_args[0]}" = --grep ]; then echo "@smoke subset"; else printf '%s\n' "${specs[@]}"; fi
	exit 0
fi

echo "e2e-affected: $label (base $base)" >&2
export PATH="$HOME/.local/opt/node/bin:$HOME/.local/opt/go/bin:$HOME/.local/bin:$PATH"
inner='
	if [ "${E2E_SKIP_BUILD:-}" != 1 ]; then NODE_OPTIONS=--max-old-space-size=4096 npm run build; fi
	E2E_SKIP_BUILD=1 npx playwright test --project=chromium "$@"
	if [ "${SMOKE_TOO:-0}" = 1 ]; then E2E_SKIP_BUILD=1 npx playwright test --project=chromium --grep @smoke; fi
'
export SMOKE_TOO=$smoke
[ "${run_args[0]}" = --grep ] && export SMOKE_TOO=0
if [ "${E2E_AFFECTED_NO_LOCK:-0}" = 1 ]; then
	exec bash -c "$inner" _ "${run_args[@]}"
fi
exec flock "${LOCK_FILE:-/tmp/heavy.lock}" bash -c "$inner" _ "${run_args[@]}"
