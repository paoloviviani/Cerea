package decide

import (
	"os"
	"path/filepath"
	"strings"
)

// The skip posture (ADR 0105 §1): `galopin run --dangerously-skip-permissions`
// answers every ask that would have become a card with "allow", except the
// four things below. It never widens the ceiling, so the refusals are
// computed here from the same inputs as the card they replace.

// Skip steps, as written to the local audit.
const (
	SkipAllow     = "skip-allow"
	SkipCeiling   = "skip-ceiling"
	SkipProtected = "skip-protected"
	SkipLoop      = "skip-loop"
)

// Refusal texts, which the agent shows its model.
const (
	SkipCeilingReason   = "This machine's policy requires a person to approve this, and nobody can while permissions are skipped, so it is refused."
	SkipProtectedReason = "This touches the machine's own configuration, credentials or CI configuration, which is never allowed without a person."
	SkipLoopReason      = "You are repeating the same call; stop and report what is blocking you."
)

// Protected is the ONE list the machine's unattended postures share (ADR 0105:
// skip's Reject list is never narrower than auto's escalate list): the paths
// no answer without a person may reach. Skip refuses on it; Cerea's auto
// pre-filter escalates on the same classes (it adds the workspace boundary and
// `.env` files, which skip deliberately accepts).
type Protected struct {
	// Home is the user's home directory, for the `~/` spelling a command uses.
	Home string
	// Dirs are absolute directories (and files) nothing under which is ever
	// reached: galopin's own state and config, the cache root, credential
	// stores, the gateway's and kit's configuration.
	Dirs []string
	// WorkspaceGlobs are workspace-relative globs that are refused for WRITES
	// only (a write there runs code in CI: a supply-chain path). Reads stay
	// allowed. `**` matches any depth.
	WorkspaceGlobs []string
}

// CIGlobs are the CI configuration files a write to which runs code in a
// pipeline, and which a review model scored as safe in a live trial: a rule,
// never left to a model.
var CIGlobs = []string{
	".github/workflows/**", ".gitlab-ci.yml", ".circleci/**", ".buildkite/**",
	"azure-pipelines.yml", "Jenkinsfile",
}

// NewProtected builds the list for a machine: home, galopin's state directory
// (policy.json, credentials, audit log, the opencode config it owns).
func NewProtected(home, stateDir string) Protected {
	var dirs []string
	add := func(p ...string) {
		for _, x := range p {
			if x != "" {
				dirs = append(dirs, filepath.Clean(x))
			}
		}
	}
	add(stateDir)
	if home != "" {
		j := func(e ...string) string { return filepath.Join(append([]string{home}, e...)...) }
		add(
			// galopin's config and the opencode config and auth it supervises
			j(".config", "galopin"), j(".config", "opencode"), j(".local", "share", "opencode"),
			// the cache root: a write there runs code past the bash ceiling
			j(".cache"),
			// credential stores
			j(".ssh"), j(".gnupg"), j(".aws"), j(".azure"), j(".kube"), j(".docker"),
			j(".config", "gcloud"), j(".config", "gh"), j(".config", "git"), j(".password-store"),
			j(".netrc"), j(".npmrc"), j(".pypirc"), j(".git-credentials"),
			// the gateway's and the kit's conventional config homes
			j(".config", "pystino"), j(".pystino"), j(".config", "cerea"), j(".cerea"),
		)
		if xdg := os.Getenv("XDG_CACHE_HOME"); xdg != "" {
			add(xdg)
		}
		if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
			add(filepath.Join(xdg, "galopin"), filepath.Join(xdg, "opencode"))
		}
	}
	return Protected{Home: home, Dirs: dirs, WorkspaceGlobs: CIGlobs}
}

// writeKeys are the permission keys that change files; bash is judged by its
// text.
func writes(cat Category, key string) bool { return cat == Edit || key == "edit" }

// Hit reports whether the request reaches the list, and what. It is
// structural: paths are compared as paths, and for bash (whose pattern is the
// command text) as substrings. It does not parse shell: an obfuscated command
// passes, which is why bash stays behind the ceiling by default.
func (pr Protected) Hit(r Request, cat Category) (string, bool) {
	for _, pat := range r.Patterns {
		if strings.HasPrefix(pat, "mcp:") {
			continue
		}
		if r.Key == "bash" {
			for _, d := range pr.Dirs {
				if strings.Contains(pat, d) || strings.Contains(pat, pr.tildeForm(d)) {
					return d, true
				}
			}
			for _, g := range pr.WorkspaceGlobs {
				if strings.Contains(pat, strings.TrimSuffix(strings.TrimSuffix(g, "**"), "/")) {
					return g, true
				}
			}
			continue
		}
		abs := pat
		if strings.HasPrefix(abs, "~/") {
			if pr.Home != "" {
				abs = filepath.Join(pr.Home, abs[2:])
			}
		} else if !filepath.IsAbs(abs) && r.Workspace != "" {
			abs = filepath.Join(r.Workspace, abs)
		}
		abs = filepath.Clean(strings.TrimSuffix(abs, "/*"))
		for _, d := range pr.Dirs {
			if under(d, abs) {
				return d, true
			}
		}
		if writes(cat, r.Key) && r.Workspace != "" {
			rel, err := filepath.Rel(r.Workspace, abs)
			if err == nil && !strings.HasPrefix(rel, "..") {
				for _, g := range pr.WorkspaceGlobs {
					if globMatch(g, filepath.ToSlash(rel)) {
						return g, true
					}
				}
			}
		}
	}
	return "", false
}

// tildeForm is dir written the way a shell command would (~/…), when it is
// under the user's home.
func (pr Protected) tildeForm(dir string) string {
	if h := pr.Home; h != "" && strings.HasPrefix(dir, h+"/") {
		return "~" + strings.TrimPrefix(dir, h)
	}
	return dir
}

func globMatch(glob, rel string) bool {
	if strings.HasSuffix(glob, "/**") {
		base := strings.TrimSuffix(glob, "/**")
		return rel == base || strings.HasPrefix(rel, base+"/")
	}
	return rel == glob
}

// Skip is the skip posture's answer to a request the ordinary function put to
// a person (res.Verdict == Card; any other result stands). It returns Once
// with step SkipAllow, or a Reject with one of the three refusal steps.
func Skip(p Policy, pr Protected, r Request, res Result) Result {
	if res.Verdict != Card {
		return res
	}
	refuse := func(step, reason string) Result {
		return Result{Verdict: Reject, Step: step, Category: res.Category, Reason: reason}
	}
	switch {
	case res.Category == Brake:
		return refuse(SkipLoop, SkipLoopReason)
	case skipRefusesCeilingCard(res):
		return refuse(SkipCeiling, SkipCeilingReason)
	case res.Step == "gp" && p.Cap(r.Key) != Once:
		// galopin's own tools raised this card because their cap says ask.
		return refuse(SkipCeiling, SkipCeilingReason)
	}
	if _, hit := pr.Hit(r, res.Category); hit {
		return refuse(SkipProtected, SkipProtectedReason)
	}
	return Result{Verdict: Once, Step: SkipAllow, Category: res.Category}
}
