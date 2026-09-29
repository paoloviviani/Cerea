# Deploying

!!! info "For operators"

    Cerea is deployed as part of a full stack from the cerea-deploy repository; this page only points there.

Cerea is not deployed on its own. The **cerea-deploy** repository holds the
whole stack: the chat, the Pystino gateway and console, a bundled identity
provider, a TLS proxy and the add-ons, as one `compose.yaml`, one commented
`.env.example` and a `./configure` script that writes your `.env` and mints
every secret.

```sh
git clone https://github.com/paoloviviani/cerea-deploy && cd cerea-deploy
./configure
docker compose up -d
```

That is the whole install. TLS modes, presets (including a chat-only install
against an existing gateway), upgrades, backups, the identity provider and
break-glass recovery are in cerea-deploy's
[README](https://github.com/paoloviviani/cerea-deploy#readme), which is the
runbook and is deliberately not repeated here. Once it is running, the
variables Cerea itself adds are on [Configuration](configuration.md), and the
optional pieces have their own pages: the [headless browser](browser.md) and
the [`/code` panel](code-panel.md).
