package decide

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
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
// and the machine agree on the same names; the machine's own decision consults
// only the .git half (GitGlobs), not CI files (a CI file is an edit).
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
	// fold compares paths case-insensitively (macOS filesystems are).
	fold bool
}

// CIGlobs are the CI configuration files a write to which runs code in a
// pipeline.
var CIGlobs = []string{
	".github/workflows/**", ".gitlab-ci.yml", ".circleci/**", ".buildkite/**",
	"azure-pipelines.yml", "Jenkinsfile",
}

// GitGlobs are a repository's own git directory: a write to its config, hooks or
// info files makes later git commands run code. Unlike CIGlobs the machine's own
// decision consults them (see Decide): an editor write there is a card even when
// the edit limit runs.
var GitGlobs = []string{".git/**"}

// NewProtected builds the list for a machine: home and galopin's state
// directory (policy.json, credentials, the audit log). extraOwn are further
// directories of galopin's own (the supervised goose's root, which follows
// --creds and not --state-dir), protected however those two are combined.
// Every directory is listed both as written and with its symlinks resolved, so
// a link into a workspace (a dotfiles repo) does not hide it.
func NewProtected(home, stateDir string, extraOwn ...string) Protected {
	pr := Protected{Home: home, fold: runtime.GOOS == "darwin", WorkspaceGlobs: append(append([]string{}, CIGlobs...), GitGlobs...)}
	add := func(dst *[]string, p ...string) {
		for _, x := range p {
			if x != "" {
				*dst = append(*dst, filepath.Clean(x))
			}
		}
	}
	add(&pr.OwnDirs, stateDir)
	add(&pr.OwnDirs, extraOwn...)
	// machine-wide secrets that no workspace holds, listed so a command that names them is a secrets ask
	add(&pr.SecretDirs, "/etc/shadow", "/etc/gshadow", "/etc/sudoers", "/etc/sudoers.d", "/etc/ssh", "/root/.ssh")
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
		// The user's own goose (ADR 0110): its config holds the local-endpoint bearer and
		// the proxy secret 'galopin goose setup' writes, and a write there could set
		// GOOSE_MODE: auto. Treated like galopin's own files, and as credential stores for reads.
		goose := []string{
			j(".config", "goose"), j(".local", "share", "goose"),
			j("Library", "Application Support", "Block", "goose"),
		}
		add(&pr.OwnDirs, goose...)
		add(&pr.SecretDirs, goose...)
		if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
			add(&pr.OwnDirs, filepath.Join(xdg, "galopin"), filepath.Join(xdg, "opencode"), filepath.Join(xdg, "goose"))
			add(&pr.SecretDirs, filepath.Join(xdg, "goose"))
		}
		if xdg := os.Getenv("XDG_DATA_HOME"); xdg != "" {
			add(&pr.OwnDirs, filepath.Join(xdg, "goose"))
			add(&pr.SecretDirs, filepath.Join(xdg, "goose"))
		}
	}
	if root := os.Getenv("GOOSE_PATH_ROOT"); root != "" {
		add(&pr.OwnDirs, root)
		add(&pr.SecretDirs, root)
	}
	pr.OwnDirs = withResolved(pr.OwnDirs)
	pr.SecretDirs = withResolved(pr.SecretDirs)
	return pr
}

// withResolved returns dirs plus, for each, its form with symlinks resolved
// (when it exists and differs).
func withResolved(dirs []string) []string {
	out := append([]string{}, dirs...)
	seen := map[string]bool{}
	for _, d := range dirs {
		seen[d] = true
	}
	for _, d := range dirs {
		if real, ok := resolve(d); ok && !seen[real] {
			seen[real] = true
			out = append(out, real)
		}
	}
	return out
}

// OwnHit reports whether the request reaches galopin's own state or config.
func (pr Protected) OwnHit(r Request) (string, bool) { return pr.hit(pr.OwnDirs, r) }

// SecretHit reports whether the request reaches a credential store.
func (pr Protected) SecretHit(r Request) (string, bool) {
	if d, ok := pr.hit(pr.SecretDirs, r); ok {
		return d, true
	}
	// /proc/<pid>/environ holds a process's environment: credentials in plain text
	for _, pat := range r.Patterns {
		if procEnviron.MatchString(filepath.Clean(pat)) || (r.Key == "bash" && procEnvironText.MatchString(pat)) {
			return "/proc/*/environ", true
		}
	}
	return "", false
}

var (
	procEnviron     = regexp.MustCompile(`^/proc/[^/]+(/task/[^/]+)?/environ$`)
	procEnvironText = regexp.MustCompile(`/proc/[^\s/]+(/task/[^\s/]+)?/environ`)
)

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
		if hasGitSegment(filepath.ToSlash(rel)) {
			return ".git/**", true
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

// hit is structural: paths are compared as paths (as written and with symlinks
// resolved) and, for bash (whose pattern is the command text), as substrings in
// the absolute, ~/ and $HOME/ spellings. It does not parse shell: an obfuscated
// command passes, which is why a command stays behind its own limit.
func (pr Protected) hit(dirs []string, r Request) (string, bool) {
	for _, pat := range r.Patterns {
		if strings.HasPrefix(pat, "mcp:") {
			continue
		}
		if r.Key == "bash" {
			text := pr.cmp(pat)
			for _, d := range dirs {
				for _, form := range pr.shellForms(d) {
					if strings.Contains(text, pr.cmp(form)) {
						return d, true
					}
				}
			}
			continue
		}
		abs := pr.abs(pat, r.Workspace)
		forms := []string{abs}
		if real, ok := resolve(abs); ok && real != abs {
			forms = append(forms, real)
		}
		for _, d := range dirs {
			for _, f := range forms {
				if under(pr.cmp(d), pr.cmp(f)) {
					return d, true
				}
			}
		}
	}
	return "", false
}

// cmp is a path as compared: folded to lower case on a case-insensitive filesystem.
func (pr Protected) cmp(p string) string {
	if pr.fold {
		return strings.ToLower(p)
	}
	return p
}

// shellForms are the ways a command can write dir: absolute, ~/…, $HOME/… and ${HOME}/….
func (pr Protected) shellForms(dir string) []string {
	forms := []string{dir}
	if h := pr.Home; h != "" && strings.HasPrefix(dir, h+"/") {
		rest := strings.TrimPrefix(dir, h)
		forms = append(forms, "~"+rest, "$HOME"+rest, "${HOME}"+rest)
	}
	return forms
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

// hasGitSegment reports whether a workspace-relative path is a repository's git
// directory (or inside one), at any depth: `.git` as a whole path segment, so
// `.gitignore` and `.github` do not match.
func hasGitSegment(rel string) bool {
	for _, seg := range strings.Split(rel, "/") {
		if seg == ".git" {
			return true
		}
	}
	return false
}
