# dex.d: federated logins for the dex+authelia identity mode

Only used when `./configure --idp dex+authelia` chose that mode (the `dex`
compose profile). Every `*.yaml` file here is one or more Dex connectors, as
list items, added after the bundled Authelia's:

```yaml
# dex.d/acme.yaml
- type: oidc
  id: acme
  name: ACME single sign-on
  config:
    issuer: https://sso.acme.example
    clientID: cerea
    clientSecret: ${ACME_CLIENT_SECRET}
    redirectURI: https://cerea.example.org/dex/callback
    insecureEnableGroups: true
    scopes: [openid, profile, email, groups]
```

- `./configure --dex-connector 'oidc id=acme ...'` writes such a file for you
  (`dex.d/10-acme.yaml`, marked as generated: re-running replaces it). A file you
  write yourself is never touched. To change what configure generated, copy it to
  a name of your own and delete the generated one.
- Secrets go in `dex.d/connectors.env` (mode 0600, `NAME=value` lines), not in
  the YAML: reference them as `${NAME}`. Compose hands that file to Dex.
- Every connector's redirect URI is `<PUBLIC_ORIGIN>/dex/callback`.
- To groups: a connector that reports groups needs `insecureEnableGroups: true`
  (oidc) or its own groups setting (ldap, saml), so the `groups` claim reaches
  the gateway.
- After adding or changing a file: `docker compose up -d --force-recreate dex`
  (`./configure` does this check for you with `./configure --check`).
- Ready-made examples for OIDC, Google, LDAP and SAML are in `examples/`.

Git ignores everything here except this file and `examples/`.
