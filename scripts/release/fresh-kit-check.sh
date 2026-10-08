#!/usr/bin/env bash
# fresh-kit-check.sh vX.Y.Z: install the deploy kit at a tag exactly as an
# operator would (get-kit.sh from GitHub), configure it non-interactively, pull
# the images with NO registry login, start it, check the running images carry
# the tag's pins, sign a throwaway (non-admin) user in through Authelia, the
# console and the chat, and print E2E_OK. The stack and the scratch directory
# are removed afterwards, pass or fail.
#
# Needs: docker with compose, curl, python3, uv, and ports 80/443 free.
# Env: CEREA_REPO (owner/name, default paoloviviani/Cerea), KEEP=1 to leave the
# stack up for inspection.
set -euo pipefail
TAG=${1:?usage: fresh-kit-check.sh vX.Y.Z}
REPO=${CEREA_REPO:-paoloviviani/Cerea}
HERE=$(cd "$(dirname "$0")" && pwd)
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/cerea-fresh-kit.XXXXXX")
PROJECT=cerea-fresh-$$
KIT=$SCRATCH/checkout/kit
cleanup() {
	if [ "${KEEP:-0}" != 1 ] && [ -d "$KIT" ]; then
		(cd "$KIT" && docker compose -p "$PROJECT" down -v >/dev/null 2>&1) || true
		rm -rf "$SCRATCH"
	fi
}
trap cleanup EXIT

curl -fsSL "https://raw.githubusercontent.com/$REPO/$TAG/kit/get-kit.sh" |
	sh -s -- --version "$TAG" --dir "$SCRATCH/checkout" >"$SCRATCH/get-kit.log" 2>&1 ||
	{ cat "$SCRATCH/get-kit.log"; exit 1; }
test ! -e "$KIT/.env" # a fresh kit carries no configuration
cd "$KIT"
cerea_pin=$(python3 tools/pin --show | sed -n 's/^cerea=//p')
pystino_pin=$(python3 tools/pin --show | sed -n 's/^pystino=//p')

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
./configure --non-interactive --origin "https://${IP:-127.0.0.1}" --admin-email admin@example.org \
	--preset homelab --tls internal --idp authelia --agents --terminal --project "$PROJECT" \
	>"$SCRATCH/configure.log" 2>&1 || { cat "$SCRATCH/configure.log"; exit 1; }

# Anonymous pulls: what an operator without a registry login gets.
mkdir -p "$SCRATCH/anon-docker" && echo '{}' >"$SCRATCH/anon-docker/config.json"
DOCKER_CONFIG=$SCRATCH/anon-docker docker compose pull -q
docker compose up -d --wait
docker compose ps --format '{{.Service}} {{.Image}} {{.Status}}'
docker compose ps --format '{{.Image}}' | grep -q "cerea:${cerea_pin}$"
docker compose ps --format '{{.Image}}' | grep -q "pystino-gateway:${pystino_pin}$"

# A throwaway user, never the administrator's account.
USER_NAME=freshcheck-$(date -u +%y%m%d%H%M)
PW=$(docker compose exec -T gateway python -c "
from pathlib import Path
from gateway.directory.authelia_users import UsersFile
_, pw = UsersFile(Path('/authelia/users_database.yml')).create('$USER_NAME', '$USER_NAME@example.org', 'Release check')
print(pw)")
LOGIN_USER=$USER_NAME LOGIN_EMAIL=$USER_NAME@example.org EXPECT_ADMIN=false \
	uv run --quiet --with httpx python "$HERE/signin_check.py" "$KIT" "$PW" --chat
