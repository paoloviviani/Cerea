# Minimal assertion kit for the installer lib tests.
#
# Every test file sources this first, then the libs under test, and runs
# under the same `set -euo pipefail` the installer runs under — so a lib
# function that trips set -u or set -e fails its test here instead of in an
# operator's terminal later. Assertion helpers never abort the file: they
# count, and the file exits non-zero at the end if anything failed.
#
# run_capture runs a lib function inside a command substitution — a
# subshell — which is exactly how install.sh's own `$( ... )` callers see
# it: a lib `fail` (printf to stderr, exit 1) ends that subshell, and OUT
# carries the message.

TESTS_PASSED=0
TESTS_FAILED=0

pass() { TESTS_PASSED=$((TESTS_PASSED + 1)); printf 'ok   %s\n' "$1"; }
flunk() { TESTS_FAILED=$((TESTS_FAILED + 1)); printf 'FAIL %s\n' "$1"; }

assert_eq() { # assert_eq <what> <want> <got>
	if [ "$2" = "$3" ]; then pass "$1"; else flunk "$1 — want [$2], got [$3]"; fi
}

assert_contains() { # assert_contains <what> <needle> <haystack>
	case "$3" in
		*"$2"*) pass "$1" ;;
		*) flunk "$1 — [$2] not in [$3]" ;;
	esac
}

assert_not_contains() { # assert_not_contains <what> <needle> <haystack>
	case "$3" in
		*"$2"*) flunk "$1 — [$2] unexpectedly in [$3]" ;;
		*) pass "$1" ;;
	esac
}

run_capture() { # run_capture <cmd...> -> OUT (combined output), RC (status)
	if OUT="$("$@" 2>&1)"; then RC=0; else RC=$?; fi
}

assert_ok() { # assert_ok <what> <cmd...> — must exit 0
	local what="$1"; shift
	run_capture "$@"
	if [ "$RC" = "0" ]; then pass "$what"; else flunk "$what — rc=$RC, out=[$OUT]"; fi
}

assert_fails() { # assert_fails <what> <cmd...> — must exit non-zero
	local what="$1"; shift
	run_capture "$@"
	if [ "$RC" != "0" ]; then pass "$what"; else flunk "$what — expected failure, rc=0, out=[$OUT]"; fi
}

assert_fails_with() { # assert_fails_with <what> <needle> <cmd...> — non-zero exit, message carries needle
	local what="$1" needle="$2" hit=0; shift 2
	run_capture "$@"
	case "$OUT" in *"$needle"*) hit=1 ;; esac
	if [ "$RC" != "0" ] && [ "$hit" = "1" ]; then
		pass "$what"
	else
		flunk "$what — rc=$RC, out=[$OUT]"
	fi
}

summary() { # summary <file> — print the counts, exit non-zero on failure
	printf '%s: %d passed, %d failed\n' "$1" "$TESTS_PASSED" "$TESTS_FAILED"
	[ "$TESTS_FAILED" = "0" ]
}
