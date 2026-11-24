package main

// A workspace's AGENTS.md for the Mistral Vibe engine.
//
// ACP has no field for per-session instructions, and Vibe loads a project's own
// AGENTS.md only for a trusted folder (galopin keeps the trust list empty, so a cloned
// repository cannot loosen the floor). What Vibe does read for every session, trusted
// folder or not, is $VIBE_HOME/AGENTS.md, once, when the session opens (the system
// prompt is built then and is not rebuilt by a model, effort or mode change; checked
// against 3.1.3). So galopin reads the workspace's file itself, under the same gate as
// opencode's (policy projectConfig), and writes it there right before each session/new
// or session/load, serialised by the ACP backend (Config.BeforeSession).

import (
	"os"
	"path/filepath"
	"strings"
)

// vibeInstructionsMax caps the instructions handed to a session, in bytes (a repository's
// file is untrusted input that goes into every request's system prompt).
const vibeInstructionsMax = 32 << 10

// instructionFiles are the file names opencode honours, in its order: the first name that
// exists anywhere between the workspace and the repository root is the one used.
var instructionFiles = []string{"AGENTS.md", "CLAUDE.md"}

// workspaceInstructions returns the instruction text for a workspace, "" when there is
// none. It walks from dir up to the repository root (the first directory holding .git;
// dir itself when there is none), takes the first file name in instructionFiles that
// exists on that path, and joins every such file outermost first. Only regular files
// count (a symlink could name a secret), a path protect names is skipped, and the whole
// is cut at vibeInstructionsMax.
func workspaceInstructions(dir string, protect func(workspace, path string) bool) string {
	dir = filepath.Clean(dir)
	var chain []string
	for cur := dir; ; {
		chain = append(chain, cur)
		if _, err := os.Lstat(filepath.Join(cur, ".git")); err == nil {
			break
		}
		parent := filepath.Dir(cur)
		if parent == cur || len(chain) >= 16 {
			// no repository root found: only the workspace itself counts
			chain = chain[:1]
			break
		}
		cur = parent
	}
	for _, name := range instructionFiles {
		var parts []string
		for i := len(chain) - 1; i >= 0; i-- { // outermost first
			p := filepath.Join(chain[i], name)
			fi, err := os.Lstat(p)
			if err != nil || !fi.Mode().IsRegular() {
				continue
			}
			if protect != nil && protect(dir, p) {
				continue
			}
			b, err := os.ReadFile(p)
			if err != nil || strings.TrimSpace(string(b)) == "" {
				continue
			}
			parts = append(parts, "Contents of "+p+" (this workspace's own instructions):\n\n"+strings.TrimSpace(string(b)))
		}
		if len(parts) == 0 {
			continue
		}
		out := strings.Join(parts, "\n\n")
		if len(out) > vibeInstructionsMax {
			out = strings.ToValidUTF8(out[:vibeInstructionsMax], "") + "\n\n[cut: the instructions are longer than galopin passes on]"
		}
		return out
	}
	return ""
}

// vibeBeforeSession is the ACP backend's BeforeSession for Vibe: it puts the workspace's
// instructions where Vibe reads its user-level ones, or removes the file when there are
// none (so one workspace's text never reaches another's session). With projectConfig off
// it only ever removes.
func vibeBeforeSession(home string, allowed bool, protect func(workspace, path string) bool, logf func(string, ...any)) func(string) {
	path := filepath.Join(home, "AGENTS.md")
	return func(workspaceDir string) {
		text := ""
		if allowed {
			text = workspaceInstructions(workspaceDir, protect)
		}
		if text == "" {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				logf("vibe: removing %s: %v", path, err)
			}
			return
		}
		if err := writeFileAtomic(path, []byte(text+"\n"), 0o600); err != nil {
			logf("vibe: writing %s: %v", path, err)
		}
	}
}
