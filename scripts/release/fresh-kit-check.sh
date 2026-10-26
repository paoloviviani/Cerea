#!/usr/bin/env bash
# fresh-kit-check.sh vX.Y.Z: install the deploy kit at a tag exactly as an
# operator would (get-kit.sh from GitHub), configure it non-interactively, pull
# the images with NO registry login, start it, check the running images carry
# the tag's pins (the chat, the gateway and the document service, which must
# be healthy and answer the chat), sign a throwaway (non-admin) user in through Authelia, the
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

# A fresh install pins its MongoDB explicitly (4.4 on a host without AVX or on an
# affected kernel, 8 otherwise); the run must not depend on compose's default.
grep -q "^MONGO_IMAGE='mongo:" .env

# Anonymous pulls: what an operator without a registry login gets.
mkdir -p "$SCRATCH/anon-docker" && echo '{}' >"$SCRATCH/anon-docker/config.json"
DOCKER_CONFIG=$SCRATCH/anon-docker docker compose pull -q
docker compose up -d --wait
docker compose ps --format '{{.Service}} {{.Image}} {{.Status}}'
docker compose ps --format '{{.Image}}' | grep -q "cerea:${cerea_pin}$"
docker compose ps --format '{{.Image}}' | grep -q "pystino-gateway:${pystino_pin}$"

# The document service (ADR 0103): the pinned image, healthy, and the chat can
# reach it with the secret it was given (and the service refuses a call without).
# Plain statements, so a failure stops the script under `set -e`.
images=$(docker compose ps --format '{{.Image}}')
grep -q "cerea-documents:${cerea_pin}$" <<<"$images"
documents_health=$(docker compose ps documents --format '{{.Health}}')
test "$documents_health" = healthy
docker compose exec -T chat node -e "
const base = process.env.CHAT_DOCUMENTS_URL, secret = process.env.CHAT_DOCUMENTS_SECRET;
(async () => {
  if (!base || !secret) throw new Error('the chat has no document service settings');
  const ok = await fetch(base + '/v1/capabilities', { headers: { 'X-Cerea-Documents-Secret': secret } });
  const refused = await fetch(base + '/v1/capabilities');
  const caps = await ok.json();
  const ops = (caps.formats && caps.formats.docx && caps.formats.docx.operations) || [];
  if (ok.status !== 200 || refused.status !== 401 || !ops.includes('replace_text')) {
    throw new Error('document service check failed: ' + ok.status + ' / ' + refused.status);
  }
  console.log('documents reachable from the chat with the shared secret; refuses a call without it; formats ' + Object.keys(caps.formats).join(','));
})().catch((e) => { console.error(e.message); process.exit(1); });"

# A chat model with no display name, then the chat restarted so it builds its
# catalogue at boot from that card. A fresh kit holds no chat model at all, so
# without this a boot-time catalogue parse never runs here: 0.15.5 crash-looped
# on every deployment whose gateway sent `display_name: null`, and this check
# still printed E2E_OK. The upstream is never called; /v1/models is the
# gateway's own catalogue.
docker compose exec -T gateway python -c "
import asyncio, uuid
from gateway.config import get_settings
from gateway.db import create_engine, create_session_factory
from gateway.models import ModelDef, ModelKind, Provider
async def main():
    engine = create_engine(get_settings())
    async with create_session_factory(engine)() as s:
        p = Provider(id=uuid.uuid4(), name='freshcheck', base_url='http://127.0.0.1:9/v1',
                     api_key_encrypted='', api_key_hint='', plugin='generic')
        s.add(p)
        await s.flush()
        s.add(ModelDef(id=uuid.uuid4(), name='freshcheck/unnamed', upstream_model='unnamed',
                       provider_id=p.id, kind=ModelKind.CHAT, is_active=True, is_public=True,
                       display_name=None))
        await s.commit()
    await engine.dispose()
asyncio.run(main())
print('seeded freshcheck/unnamed (display_name null)')"

# An alias card with both display_name and description null (ADR 0101). The
# 0.15.5 boot loop was the chat parsing a gateway card strictly; the unnamed
# model above covers a card with no display name, and this one covers a card
# that is an alias as well. Guarded on the *table*, not on a version number: a
# table exists iff the gateway's migrations have run, which is the thing that
# actually decides whether the insert below can work, and it needs no version
# comparison to keep in step with a release.
docker compose exec -T gateway python -c "
import asyncio, uuid
import sqlalchemy as sa
from gateway.config import get_settings
from gateway.db import create_engine, create_session_factory
from gateway.models import ModelDef, ModelKind
async def main():
    engine = create_engine(get_settings())
    async with engine.connect() as conn:
        has_aliases = await conn.run_sync(
            lambda c: sa.inspect(c).has_table('model_route_targets'))
    if not has_aliases:
        print('gateway has no model aliases; skipping the alias seed')
        await engine.dispose()
        return
    from gateway.models import ModelRouteTarget
    async with create_session_factory(engine)() as s:
        target = (await s.execute(sa.select(ModelDef).where(ModelDef.name == 'freshcheck/unnamed'))).scalar_one()
        alias = ModelDef(id=uuid.uuid4(), name='freshcheck/alias', provider_id=None,
                         upstream_model=None, is_alias=True, kind=target.kind,
                         is_active=True, is_public=True,
                         display_name=None, description=None)
        s.add(alias)
        await s.flush()
        # One target, which is what this step supports: the save path writes
        # exactly one route row, and so does this seed.
        s.add(ModelRouteTarget(alias_id=alias.id, target_model_id=target.id, position=0))
        await s.commit()
    await engine.dispose()
asyncio.run(main())
print('seeded freshcheck/alias (an alias, display_name and description null)')"
docker compose restart chat
docker compose up -d --wait chat

# A throwaway user, never the administrator's account.
USER_NAME=freshcheck-$(date -u +%y%m%d%H%M)
PW=$(docker compose exec -T gateway python -c "
from pathlib import Path
from gateway.directory.authelia_users import UsersFile
_, pw = UsersFile(Path('/authelia/users_database.yml')).create('$USER_NAME', '$USER_NAME@example.org', 'Release check')
print(pw)")
LOGIN_USER=$USER_NAME LOGIN_EMAIL=$USER_NAME@example.org EXPECT_ADMIN=false \
	uv run --quiet --with httpx python "$HERE/signin_check.py" "$KIT" "$PW" --chat
