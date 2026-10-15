#!/usr/bin/env bash
# Run the delegation evaluation (see README.md). Usage:
#   eval/delegation/run.sh <label> [<agent-dir>]
# <label> names the results file (baseline, after); <agent-dir> is the agent/
# checkout to test (default: this one). The key comes from the env file, never
# from the command line, and is never printed.
set -euo pipefail
label=${1:?label}
agent=${2:-$(cd "$(dirname "$0")/../.." && pwd)}
envfile=${EVAL_ENV_FILE:-$HOME/.config/galopin-eval.env}
set -a; . "$envfile"; set +a
: "${EVAL_MODELS:=deepseek-v4-flash-0731 glm-5.3}"
export EVAL_MODELS EVAL_OUT="${EVAL_OUT:-/tmp/delegation-eval-$label.json}"
# The harness file lives in this checkout; copy it into a checkout that lacks it
# (the baseline), together with the prompts.
here=$(cd "$(dirname "$0")/../.." && pwd)
if [ "$agent" != "$here" ]; then
  mkdir -p "$agent/eval/delegation"
  cp "$here/delegation_eval_it_test.go" "$agent/"
  cp "$here/eval/delegation/prompts.json" "$agent/eval/delegation/"
fi
cd "$agent"
GALOPIN_DELEGATION_EVAL=1 flock /tmp/heavy.lock go test -run TestDelegationEval -v -timeout 90m . | grep -v -i "$EVAL_GATEWAY_KEY"
echo "results: $EVAL_OUT"
