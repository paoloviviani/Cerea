package decide

import (
	"os"
	"path/filepath"
	"strings"
)

// Protected is the machine's list of paths no answer may reach (ADR 0107 §1).
// It has two halves with different jobs:
//
//   - OwnDirs are galopin's own state and configuration and the opencode
//     configuration it owns: a request that touches them is refused outright,
//     whatever any limit or session word says. That floor is not a class.
//   - SecretDirs are credential stores: a request that touches them belongs to
//     the secrets class (never or ask; it never runs), alongside `.env` files.
//
// WorkspaceGlobs are CI configuration files (CIGlobs) a write to which runs
// code in a pipeline. They are part of the list so a Cerea-side escalate list
// and the machine agree on the same names; the machine's own decision does
// not consult them (a CI file is an edit).
type Protected struct {
	// Home is the user's home directory, for the `~/` spelling a command uses.
	Home string
	// OwnDirs are absolute directories (and files) of galopin's own.
	OwnDirs []string
	// SecretDirs are absolute credential directories (and files).
	SecretDirs []string
	// WorkspaceGlobs are workspace-relative globs for WRITES only. `**` matches
	// any depth.
	WorkspaceGlobs []string
}

// CIGlobs are the CI configuration files a write to which runs code in a
// pipeline.
var CIGlobs = []string{
	".github/workflows/**", ".gitlab-ci.yml", ".circleci/**", ".buildkite/**",
	"azure-pipelines.yml", "Jenkinsfile",
}

// NewProtected builds the list for a machine: home and galopin's state
// directory (policy.json, credentials, the audit log).
func NewProtected(home, stateDir string) Protected {
	pr := Protected{Home: home, WorkspaceGlobs: CIGlobs}
	add := func(dst *[]string, p ...string) {
		for _, x := range p {
			if x != "" {
				*dst = append(*dst, filepath.Clean(x))
			}
		}
	}
	add(&pr.OwnDirs, stateDir)
	if home != "" {
		j := func(e ...string) string { return filepath.Join(append([]string{home}, e...)...) }
		add(&pr.OwnDirs, j(".config", "galopin"), j(".config", "opencode"), j(".local", "share", "opencode"))
		add(&pr.SecretDirs,
			j(".ssh"), j(".gnupg"), j(".aws"), j(".azure"), j(".kube"), j(".docker"),
			j(".config", "gcloud"), j(".config", "gh"), j(".config", "git"), j(".password-store"),
			j(".netrc"), j(".npmrc"), j(".pypirc"), j(".git-credentials"),
			// the gateway's and the kit's conventional config homes
			j(".config", "pystino"), j(".pystino"), j(".config", "cerea"), j(".cerea"),
		)
		if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
			add(&pr.OwnDirs, filepath.Join(xdg, "galopin"), filepath.Join(xdg, "opencode"))
		}
	}
	return pr
}

// OwnHit reports whether the request reaches galopin's own state or config.
func (pr Protected) OwnHit(r Request) (string, bool) { return pr.hit(pr.OwnDirs, r) }

// SecretHit reports whether the request reaches a credential store.
func (pr Protected) SecretHit(r Request) (string, bool) { return pr.hit(pr.SecretDirs, r) }

// CIHit reports whether a write request reaches a CI configuration file.
func (pr Protected) CIHit(r Request) (string, bool) {
	if r.Key != "edit" || r.Workspace == "" {
		return "", false
	}
	for _, pat := range r.Patterns {
		abs := pr.abs(pat, r.Workspace)
		rel, err := filepath.Rel(r.Workspace, abs)
		if err != nil || strings.HasPrefix(rel, "..") {
			continue
		}
		for _, g := range pr.WorkspaceGlobs {
			if globMatch(g, filepath.ToSlash(rel)) {
				return g, true
			}
		}
	}
	return "", false
}

func (pr Protected) abs(pat, workspace string) string {
	abs := pat
	if strings.HasPrefix(abs, "~/") {
		if pr.Home != "" {
			abs = filepath.Join(pr.Home, abs[2:])
		}
	} else if !filepath.IsAbs(abs) && workspace != "" {
		abs = filepath.Join(workspace, abs)
	}
	return filepath.Clean(strings.TrimSuffix(abs, "/*"))
}

// hit is structural: paths are compared as paths and, for bash (whose pattern
// is the command text), as substrings. It does not parse shell: an obfuscated
// command passes, which is why a command stays behind its own limit.
func (pr Protected) hit(dirs []string, r Request) (string, bool) {
	for _, pat := range r.Patterns {
		if strings.HasPrefix(pat, "mcp:") {
			continue
		}
		if r.Key == "bash" {
			for _, d := range dirs {
				if strings.Contains(pat, d) || strings.Contains(pat, pr.tildeForm(d)) {
					return d, true
				}
			}
			continue
		}
		abs := pr.abs(pat, r.Workspace)
		for _, d := range dirs {
			if under(d, abs) {
				return d, true
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
