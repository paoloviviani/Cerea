# Dex's configuration for the dex+authelia identity mode, rendered by the
# image's own entrypoint (gomplate) when the container starts: nothing is
# rendered on the host, so nothing drifts. Values arrive through the
# container's environment (compose.yaml <- .env); connectors beyond Authelia
# arrive as the files in dex.d/ (mounted at /etc/dex.d).
#
# This file is not state and not yours to edit: an upgrade replaces it. Add
# a federated login with `./configure --dex-connector ...` (it writes a file
# into dex.d/) or write your own file there; see dex.d/README.md.
#
# NEVER write a double-brace template expression in a comment in this file:
# gomplate runs the whole file, comments included.

issuer: {{ getenv "DEX_ISSUER" | data.ToJSON }}

storage:
  type: postgres
  config:
    host: postgres
    port: 5432
    database: dex
    user: dex
    password: {{ getenv "DEX_PG_PASSWORD" | data.ToJSON }}
    ssl:
      mode: disable

web:
  http: 0.0.0.0:5556

logger:
  level: info
  format: text

oauth2:
  # The three clients below are first-party: no consent screen.
  skipApprovalScreen: true
  responseTypes: ["code"]

# An access token lives as long as an ID token. A machine's refresh token
# (galopin) stays valid while it is used, and for 90 days idle, as the
# Authelia-alone mode's agent_machine lifespan does.
expiry:
  idTokens: 1h
  deviceRequests: 10m
  refreshTokens:
    validIfNotUsedFor: 2160h

# Local accounts live in Authelia (a connector below); Dex keeps none.
enablePasswordDB: false

# Dex puts no audience in a token except the client's own, and names a second
# one only when the client asks for it with an audience:server:client_id:<id>
# scope, which the id's own client must trust. One audience has to satisfy the
# gateway for all three clients, so it is the machine client's id: the console
# and the chat ask for it (./configure writes their scopes) and galopin's own
# token carries it already. Hence the trustedPeers on that client.
staticClients:
  - id: {{ getenv "DEX_CONSOLE_CLIENT_ID" | data.ToJSON }}
    name: Pystino Console
    secret: {{ getenv "DEX_CONSOLE_CLIENT_SECRET" | data.ToJSON }}
    redirectURIs:
      - {{ printf "%s/auth/callback/default" (getenv "PUBLIC_ORIGIN") | data.ToJSON }}
      - {{ printf "%s/auth/callback" (getenv "PUBLIC_ORIGIN") | data.ToJSON }}
  - id: {{ getenv "DEX_CHAT_CLIENT_ID" | data.ToJSON }}
    name: Cerea Chat
    secret: {{ getenv "DEX_CHAT_CLIENT_SECRET" | data.ToJSON }}
    redirectURIs:
      - {{ printf "%s/chat/login/callback" (getenv "PUBLIC_ORIGIN") | data.ToJSON }}
  # galopin's public client: the device flow (Dex requires /device/callback
  # among a device client's redirect URIs) and a loopback browser flow.
  - id: {{ getenv "DEX_MACHINE_CLIENT_ID" | data.ToJSON }}
    name: Opencode Enrollment
    public: true
    redirectURIs:
      - /device/callback
      - http://127.0.0.1/callback
      - http://localhost/callback
    trustedPeers:
      - {{ getenv "DEX_CONSOLE_CLIENT_ID" | data.ToJSON }}
      - {{ getenv "DEX_CHAT_CLIENT_ID" | data.ToJSON }}

connectors:
  # The bundled Authelia: local accounts, the console's Users page, password
  # change and break-glass recovery. It is reached through dex-backchannel
  # (dex/backchannel.Caddyfile), which names the public origin to Authelia, so
  # the issuer in its tokens is the public one while no request leaves the
  # compose network.
  - type: oidc
    id: authelia
    name: {{ getenv "DEX_AUTHELIA_NAME" | data.ToJSON }}
    config:
      issuer: http://dex-backchannel:9092/authelia
      issuerAlias: {{ printf "%s/authelia" (getenv "PUBLIC_ORIGIN") | data.ToJSON }}
      providerDiscoveryOverrides:
        tokenURL: http://dex-backchannel:9092/authelia/api/oidc/token
        jwksURL: http://dex-backchannel:9092/authelia/jwks.json
      clientID: dex
      clientSecret: {{ getenv "DEX_AUTHELIA_CLIENT_SECRET" | data.ToJSON }}
      redirectURI: {{ printf "%s/dex/callback" (getenv "PUBLIC_ORIGIN") | data.ToJSON }}
      # Set outright: with discovery overrides Dex cannot read the issuer's
      # own list (it logs a warning that the method is unsupported, wrongly).
      pkceChallenge: S256
      # A machine's device flow asks Dex for offline_access, and Dex then sends
      # prompt=consent to Authelia, whose consent screen would interrupt every
      # enrollment. The first-party clients are consented in advance.
      promptType: ""
      # offline_access: Dex renews a machine's token through the one it holds
      # from Authelia, which Authelia issues only for this scope.
      scopes: [openid, profile, email, groups, offline_access]
      insecureEnableGroups: true
{{- range file.ReadDir "/etc/dex.d" }}{{ if strings.HasSuffix ".yaml" . }}
{{ file.Read (printf "/etc/dex.d/%s" .) | strings.Indent 2 }}
{{- end }}{{ end }}
