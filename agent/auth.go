package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

const authUsage = `galopin auth — sign in again without re-enrolling, change the billing group, or show the credential's state.

Usage:
  galopin auth login    [--creds PATH] [--device | --loopback]
  galopin auth refresh  [--creds PATH] [--device | --loopback]
  galopin auth group    [NAME | --default] [--creds PATH]
  galopin auth status   [--creds PATH]

  login     ('refresh' is an alias) Signs in once more with the issuer, client
            id and flow the credential file recorded, and rewrites ONLY the
            token fields of that file (atomically, mode 0600): the machine
            id, billing group, gateway, shim port, opencode.json path and
            policy stay exactly as they are, and no new machine id is minted
            — unlike 'galopin enroll', the /code panel never shows the
            machine as a new Pending device. The new token is verified
            against the gateway, and the recorded billing group must still
            be billable: one that is not is reported and nothing is written,
            'galopin enroll' picks another. It is refused when the file is
            missing or records no issuer or client id, and on a revoked
            machine — that machine id is dead by design, so only 'enroll'
            (which mints a new one) is the way back. The write takes the
            same cross-process lock the shim refreshes under, so a running
            'galopin run' adopts the new credential at its next refresh, and
            a shim that had latched its "expired" state recovers on its next
            request or tick — no restart.
  status    Read-only: the issuer, the user, the billing group, when the
            access token expires, whether the refresh credential is present,
            whether the shim last saw the credential permanently refused
            (its status.json verdict), and whether the machine is revoked.

  group     With no argument: list the billable groups, marking the current
            one. With a NAME: bill this machine to NAME instead — verified
            against the live list, only the group field of credentials.json
            rewritten (atomically, 0600, under the same lock the shim
            refreshes under), then the models map re-discovered for the new
            group, because the visible models depend on it. No new machine
            id, nothing else touched.

  --creds     Credential file (default <config-dir>/galopin/credentials.json).
  --device    Force the device code flow (headless boxes; see 'enroll --device').
  --loopback  Force the loopback browser flow (see 'enroll --loopback').
`

// authCommandOptions carries the subset of enroll's flags `auth login`
// accepts: the credential path and the sign-in flow. Everything else a
// re-enroll could redefine is exactly what this command exists not to touch.
type authCommandOptions struct {
	creds    string
	device   bool
	loopback bool
}

func runAuth(args []string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "-help" || args[0] == "--help" || args[0] == "help" {
		fmt.Fprint(os.Stderr, authUsage)
		if len(args) == 0 {
			return exitError{code: 2}
		}
		return nil
	}
	switch args[0] {
	case "login", "refresh":
		return runAuthLogin(args[1:])
	case "group":
		return runAuthGroup(args[1:])
	case "status":
		return runAuthStatus(args[1:])
	default:
		return fmt.Errorf("unknown auth command %q\n\n%s", args[0], authUsage)
	}
}

func runAuthLogin(args []string) error {
	fs := flagSetWithHelp("auth login", authUsage)
	var opts authCommandOptions
	fs.StringVar(&opts.creds, "creds", "", "")
	fs.BoolVar(&opts.device, "device", false, "")
	fs.BoolVar(&opts.loopback, "loopback", false, "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	if opts.device && opts.loopback {
		return fmt.Errorf("--device and --loopback conflict: pick one flow")
	}
	if opts.creds == "" {
		path, err := resolveDefaultCredsPath()
		if err != nil {
			return err
		}
		opts.creds = path
	}
	return authLogin(context.Background(), &opts)
}

// lenientLoadCredentials reads a credential file without demanding the token
// fields: `auth` must still see the recorded settings of a file whose tokens
// were cleared (a revoked machine, an expired enrollment). A corrupt file is
// still refused: acting on half of one is worse than stopping at it. The
// missing-file case is the refusal itself — it names the way in, because
// nothing recorded is a guess the login could ever make.
func lenientLoadCredentials(path string) (*credentials, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("no credential file at %s: run 'galopin enroll' first", path)
		}
		return nil, fmt.Errorf("reading creds: %w", err)
	}
	var creds credentials
	if err := json.Unmarshal(body, &creds); err != nil {
		return nil, fmt.Errorf("parsing creds: %w", err)
	}
	return &creds, nil
}

// authLogin signs the machine in again without it enrolling again. The
// settings come from the credential file and only that file's token fields
// are rewritten, so the machine keeps its identity at Cerea. Revoked is
// refused by design: its identity is gone at the other end, and a new token
// for it is worthless.
func authLogin(ctx context.Context, opts *authCommandOptions) error {
	credsPath := opts.creds
	rec, err := lenientLoadCredentials(credsPath)
	if err != nil {
		return err
	}
	if rec.Issuer == "" || rec.ClientID == "" {
		return fmt.Errorf("%s records no issuer or client id to sign in with: run 'galopin enroll' first", credsPath)
	}
	if rec.Gateway == "" {
		return fmt.Errorf("%s records no gateway, so a new token could not be verified: run 'galopin enroll' first", credsPath)
	}
	if revokedAt(filepath.Dir(credsPath), credsPath) {
		return fmt.Errorf("this machine was revoked in the chat's /code panel and must re-enroll by design: run 'galopin enroll' (that mints a new machine id)")
	}

	issuer := strings.TrimSuffix(rec.Issuer, "/")
	doc, err := fetchDiscovery(ctx, issuer)
	if err != nil {
		return err
	}
	useDevice, err := selectFlow(doc, opts.device, opts.loopback)
	if err != nil {
		return err
	}
	if useDevice {
		fmt.Fprintln(os.Stderr, "no usable browser here — signing in with the device code flow.")
	}
	tokens, err := signIn(ctx, doc, rec.ClientID, useDevice, defaultDeviceHooks())
	if err != nil {
		return err
	}

	// The gateway verifies both the fresh token and the recorded billing
	// group before anything is written: a credential whose x-bill-to the
	// gateway refuses on every request is worse than no credential, because
	// nothing in it would say why.
	groups, err := fetchGroups(ctx, rec.Gateway, tokens.AccessToken)
	if err != nil {
		return fmt.Errorf("verifying the new token against the gateway: %w", err)
	}
	if rec.Group != "" && !slices.ContainsFunc(groups, func(g billableGroup) bool { return g.Name == rec.Group }) {
		fmt.Fprintf(os.Stderr, "warning: the recorded billing group %q is no longer billable for this user.\n", rec.Group)
		return fmt.Errorf("token NOT written (the recorded billing group %q is not billable): run 'galopin enroll' to pick another group", rec.Group)
	}

	// The same cross-process lock the shim's refresh takes (R7): a running
	// 'run' re-reads the file on every refresh, so it adopts this result —
	// even one latched as "expired", which recovers without a restart. The
	// file is re-read under the lock, because the shim may have rotated the
	// tokens while the sign-in ran, and only the newest file's other fields
	// deserve to stand.
	unlock, err := lockCredsFile(credsPath)
	if err != nil {
		return fmt.Errorf("locking the credentials for writing: %w", err)
	}
	defer unlock()
	latest, err := lenientLoadCredentials(credsPath)
	if err != nil {
		return err
	}
	latest.RefreshToken = tokens.RefreshToken
	latest.AccessToken = tokens.AccessToken
	latest.ExpiresIn = tokens.ExpiresIn
	latest.ObtainedAt = time.Now().Unix()
	if err := saveCredentials(credsPath, latest); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "signed in again: token fields of %s rewritten (mode 0600); machine id, billing group, gateway, shim port, opencode.json path and policy untouched.\n", credsPath)
	fmt.Fprintf(os.Stderr, "billing group %s is still billable; access token expires at %s.\n", latest.Group, latest.accessExpiry().Format("2006-01-02 15:04:05 MST"))
	fmt.Fprintf(os.Stderr, "a running 'galopin run' adopts this at its next refresh or request — no restart needed.\n")
	return nil
}

func runAuthGroup(args []string) error {
	fs := flagSetWithHelp("auth group", authUsage)
	var credsPath string
	fs.StringVar(&credsPath, "creds", "", "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	// One name; joined so a group whose name contains a space can be typed
	// the way it is spelled. Validation against the live list is what
	// catches a typo either way.
	name := strings.Join(fs.Args(), " ")
	if len(fs.Args()) > 1 {
		return fmt.Errorf("one billing group at a time: got %q", name)
	}
	if credsPath == "" {
		path, err := resolveDefaultCredsPath()
		if err != nil {
			return err
		}
		credsPath = path
	}
	ctx, cancel := context.WithTimeout(context.Background(), modelsRefreshTimeout+30*time.Second)
	defer cancel()
	return authGroup(ctx, credsPath, name)
}

// billingModeLine is how both 'auth group' and 'auth status' name the
// machine's billing mode.
func billingModeLine(rec *credentials, groups []billableGroup) string {
	if rec.BillToDefault {
		current := "none set"
		for _, g := range groups {
			if g.IsDefault {
				current = g.Name
			}
		}
		return fmt.Sprintf("following your default (currently: %s)", current)
	}
	return fmt.Sprintf("pinned: %s", rec.Group)
}

// authGroup moves the machine's billing to NAME (or lists the choices when
// NAME is empty). The group is a billing identity, not an enrollment one:
// it is verified against the live list exactly as pickGroup verifies an
// explicit --group, and only the group field is rewritten — the machine
// id, the tokens and every recorded setting stay exactly as they are.
func authGroup(ctx context.Context, credsPath, name string) error {
	rec, err := lenientLoadCredentials(credsPath)
	if err != nil {
		return err
	}
	if rec.Gateway == "" {
		return fmt.Errorf("%s records no gateway, so the choices cannot be checked: run 'galopin enroll' first", credsPath)
	}
	if revokedAt(filepath.Dir(credsPath), credsPath) {
		return fmt.Errorf("this machine was revoked in the chat's /code panel and must re-enroll by design: run 'galopin enroll' (that mints a new machine id)")
	}

	// The same token path 'galopin models refresh' uses: refreshCredential
	// under the cross-process lock, adopting a rotation another process
	// already did and persisting a rotated refresh token.
	creds := *rec
	token := func(context.Context) (string, error) { return accessTokenFor(credsPath, &creds) }
	access, err := token(ctx)
	if err != nil {
		return fmt.Errorf("signing in with the stored credential: %w", err)
	}
	groups, err := fetchGroups(ctx, rec.Gateway, access)
	if err != nil {
		return err
	}
	names := make([]string, len(groups))
	for i, g := range groups {
		names[i] = g.Name
		if g.IsDefault {
			names[i] += " (default)"
		}
	}

	if name == "" {
		fmt.Printf("billing mode: %s\n", billingModeLine(rec, groups))
		fmt.Println("billable groups:")
		for _, g := range groups {
			marker := ""
			if !rec.BillToDefault && g.Name == rec.Group {
				marker = " (current)"
			}
			if g.IsDefault {
				marker += " (default)"
			}
			fmt.Printf("  %s%s\n", g.Name, marker)
		}
		return nil
	}

	// An explicit name must be a current membership, never trusted blind.
	if !slices.ContainsFunc(groups, func(g billableGroup) bool { return g.Name == name }) {
		return fmt.Errorf("group %q is not billable for this user (choices: %s)", name, strings.Join(names, ", "))
	}

	// Under the same lock the shim refreshes under, re-reading first: the
	// shim or a concurrent 'auth login' may have rotated the tokens while
	// this command verified the name, and the file's newest state is what
	// the one-field change applies to.
	unlock, err := lockCredsFile(credsPath)
	if err != nil {
		return fmt.Errorf("locking the credentials for writing: %w", err)
	}
	latest, err := lenientLoadCredentials(credsPath)
	if err != nil {
		unlock()
		return err
	}
	latest.Group = name
	if err := saveCredentials(credsPath, latest); err != nil {
		unlock()
		return err
	}
	unlock()
	fmt.Fprintf(os.Stderr, "billing group changed to %s: only the group field of %s was rewritten.\n", name, credsPath)

	// The visible models depend on the group (A), so the same re-discovery
	// 'galopin models refresh' runs happens now, against the new group.
	diff, err := refreshModels(ctx, latest, token)
	if err != nil {
		fmt.Fprintf(os.Stderr, "warning: the group is set, but re-discovering the models failed (%v) — run 'galopin models refresh'.\n", err)
	} else {
		fmt.Fprint(os.Stderr, diff.Summary(latest.OpencodeConfig))
		for _, w := range diff.Warnings {
			fmt.Fprintf(os.Stderr, "warning: %s\n", w)
		}
	}
	// Billing follows at once (the shim re-reads the file); the model list
	// a running run holds is the one it started with.
	fmt.Fprintln(os.Stderr, "a running 'galopin run' bills to the new group from its next request on; restart it to pick up the new model list.")
	return nil
}

func runAuthStatus(args []string) error {
	fs := flagSetWithHelp("auth status", authUsage)
	var credsPath string
	fs.StringVar(&credsPath, "creds", "", "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}
	if credsPath == "" {
		path, err := resolveDefaultCredsPath()
		if err != nil {
			return err
		}
		credsPath = path
	}
	return authStatus(credsPath)
}

// authStatus reports what the credential file and the shim's status.json say,
// and writes nothing: it is how an operator answers "why are requests 401-ing"
// without re-deriving the state. A revoked machine had its tokens cleared, and
// status is exactly where that is made legible rather than an error.
func authStatus(credsPath string) error {
	rec, err := lenientLoadCredentials(credsPath)
	if err != nil {
		return err
	}
	dir := filepath.Dir(credsPath)
	fmt.Printf("credential file: %s\n", credsPath)
	fmt.Printf("issuer: %s\n", rec.Issuer)
	if user := jwtUser(rec.AccessToken); user != "" {
		fmt.Printf("user: %s\n", user)
	} else {
		fmt.Printf("user: unknown\n")
	}
	if rec.Group == "" {
		fmt.Printf("billing group: none recorded\n")
	} else {
		fmt.Printf("billing group: %s\n", rec.Group)
	}
	switch {
	case rec.AccessToken == "" || rec.ObtainedAt <= 0:
		fmt.Printf("access token: none\n")
	case rec.accessExpiry().Before(time.Now()):
		fmt.Printf("access token: expired at %s\n", rec.accessExpiry().Format(time.RFC3339))
	default:
		fmt.Printf("access token: until %s\n", rec.accessExpiry().Format(time.RFC3339))
	}
	if rec.RefreshToken != "" {
		fmt.Printf("refresh credential: present\n")
	} else {
		fmt.Printf("refresh credential: ABSENT (the shim cannot renew; run 'galopin enroll' first)\n")
	}
	if status, err := readStatusFile(statusPathFor(credsPath)); err == nil {
		fmt.Printf("shim verdict: %s — %s (checked %s)\n", status.State, status.Message, status.CheckedAt.Format(time.RFC3339))
	} else {
		fmt.Printf("shim verdict: none recorded (no status.json; 'serve' has not run here)\n")
	}
	if revokedAt(dir, credsPath) {
		fmt.Printf("machine: REVOKED — must re-enroll ('galopin enroll' mints a new machine id)\n")
	} else {
		fmt.Printf("machine: not revoked\n")
	}
	return nil
}

// jwtUser pulls a displayable identity out of an access token without
// validating it: the signature is the gateway's problem, and this answers
// "which account does this machine run as", not "is this token good". A
// bearer token from an IdP that does not issue JWTs yields nothing.
func jwtUser(token string) string {
	if strings.Count(token, ".") != 2 {
		return ""
	}
	parts := strings.Split(token, ".")
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		Email             string `json:"email"`
		PreferredUsername string `json:"preferred_username"`
		Sub               string `json:"sub"`
	}
	if json.Unmarshal(payload, &claims) != nil {
		return ""
	}
	for _, v := range []string{claims.Email, claims.PreferredUsername} {
		if v != "" {
			return v
		}
	}
	return claims.Sub
}
