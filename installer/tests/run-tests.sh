#!/usr/bin/env bash
#
# The installer's self-contained test runner: bash, coreutils and openssl —
# nothing else (the installer's own zero-dependency rule). Each test file
# runs in its own bash because the libs keep state in globals (VALUES,
# PARSED, SCRUB, ...): a clean shell per file is the isolation.
#
#   ./installer/tests/run-tests.sh

set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
overall=0
for t in "$here"/test-*.sh; do
	printf '\n== %s ==\n' "$(basename "$t")"
	if bash "$t"; then :; else overall=1; fi
done
printf '\n'
if [ "$overall" = "0" ]; then
	printf 'All installer lib tests passed.\n'
else
	printf 'Installer lib test FAILURES above.\n'
fi
exit "$overall"
