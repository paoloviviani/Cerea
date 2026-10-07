# proxy.d — your own Caddy snippets

Every `*.caddy` file here is imported inside the site block of
`caddy/Caddyfile`, before the stack's own routes. Use it for an extra route,
a header, or an IP allow-list, without editing a tracked file:

```caddy
# proxy.d/robots.caddy
handle /robots.txt {
	respond "User-agent: *
Disallow: /" 200
}
```

Git ignores `*.caddy` in this directory, so an upgrade never conflicts with
yours. After adding or changing one:

```sh
docker compose exec proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```
