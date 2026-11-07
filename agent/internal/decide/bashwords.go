package decide

import (
	"os/user"
	"path/filepath"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

// Bash is judged on the command text, not only on opencode's `patterns` (audit
// H1, M1): the text is parsed with mvdan/sh, the way the read-only rule does,
// and every word is a candidate path. Words are expanded for the spellings a
// shell gives them (`~`, `~user`, `$HOME`, `${HOME}`), resolved against the
// working directory the command has reached (`cd X && cat y` tracks X), and
// compared as paths (case-folded on macOS, symlinks resolved). Anything not
// understood falls back to the raw text, which the substring match keeps.

// commandTexts is every text of a bash request that names what runs: the
// agent's full command line and each pattern.
func (r Request) commandTexts() []string {
	out := make([]string, 0, len(r.Patterns)+1)
	if r.Command != "" {
		out = append(out, r.Command)
	}
	for _, p := range r.Patterns {
		if r.Command == "" || p != r.Command {
			out = append(out, p)
		}
	}
	return out
}

// shellWords are the words of a command line with their expansions, and the
// directories its `cd` calls reach. ok is false when a text does not parse.
type shellWords struct {
	words []string // expanded, as written otherwise (relative stays relative)
	cwds  []string // starting directory first, then each `cd` target reached
}

func (pr Protected) shellWords(text, workspace string) shellWords {
	sw := shellWords{cwds: []string{workspace}}
	f, err := syntax.NewParser(syntax.Variant(syntax.LangBash)).Parse(strings.NewReader(text), "")
	if err != nil {
		return sw
	}
	cur := workspace
	syntax.Walk(f, func(n syntax.Node) bool {
		c, ok := n.(*syntax.CallExpr)
		if !ok {
			return true
		}
		var args []string
		for _, w := range c.Args {
			if s, ok := pr.expandWord(w); ok {
				args = append(args, s)
				sw.words = append(sw.words, s)
			}
		}
		for _, a := range c.Assigns {
			if a.Value != nil {
				if s, ok := pr.expandWord(a.Value); ok {
					sw.words = append(sw.words, s)
				}
			}
		}
		if len(args) >= 1 && (args[0] == "cd" || args[0] == "pushd") {
			target := pr.Home
			if len(args) >= 2 && !strings.HasPrefix(args[len(args)-1], "-") {
				target = args[len(args)-1]
			}
			if target != "" {
				cur = pr.joinCwd(cur, target)
				sw.cwds = append(sw.cwds, cur)
			}
		}
		return true
	})
	return sw
}

func (pr Protected) joinCwd(cwd, p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	if cwd == "" {
		return ""
	}
	return filepath.Join(cwd, p)
}

// expandWord is a word's text with `~`, `~user`, `$HOME` and `${HOME}` expanded.
// Other expansions make the word unknown (ok false): its literal pieces are
// still seen by the substring match.
func (pr Protected) expandWord(w *syntax.Word) (string, bool) {
	var sb strings.Builder
	var emit func(parts []syntax.WordPart, first bool) bool
	emit = func(parts []syntax.WordPart, first bool) bool {
		for i, part := range parts {
			switch x := part.(type) {
			case *syntax.Lit:
				v := x.Value
				if first && i == 0 && strings.HasPrefix(v, "~") {
					name, rest, _ := strings.Cut(v[1:], "/")
					home := pr.homeOf(name)
					if home == "" {
						return false
					}
					v = home
					if rest != "" || strings.Contains(x.Value, "/") {
						v += "/" + rest
					}
				}
				sb.WriteString(strings.ReplaceAll(v, `\`, ""))
			case *syntax.SglQuoted:
				sb.WriteString(x.Value)
			case *syntax.DblQuoted:
				if !emit(x.Parts, false) {
					return false
				}
			case *syntax.ParamExp:
				if x.Param == nil || x.Param.Value != "HOME" || x.Exp != nil || x.Length || x.Width || x.Index != nil || x.Slice != nil || x.Repl != nil || pr.Home == "" {
					return false
				}
				sb.WriteString(pr.Home)
			default:
				return false
			}
		}
		return true
	}
	if w == nil || !emit(w.Parts, true) {
		return "", false
	}
	return sb.String(), true
}

// homeOf is the home directory `~name` stands for ("" for `~`: the user's own).
func (pr Protected) homeOf(name string) string {
	if name == "" {
		return pr.Home
	}
	if u, err := user.Lookup(name); err == nil && u.HomeDir != "" {
		return u.HomeDir
	}
	if name == "root" {
		return "/root"
	}
	if pr.Home != "" {
		return filepath.Join(filepath.Dir(pr.Home), name)
	}
	return ""
}

// bashPaths are the absolute paths a bash request's words can name, each
// resolved against every directory the command reaches; a word `REV:path` or
// `--opt=path` also yields its path half.
func (pr Protected) bashPaths(r Request) []string {
	var out []string
	seen := map[string]bool{}
	add := func(p string) {
		if p != "" && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	for _, text := range r.commandTexts() {
		sw := pr.shellWords(text, r.Workspace)
		for _, w := range sw.words {
			cands := []string{w}
			if i := strings.IndexAny(w, "=:"); i > 0 && i+1 < len(w) {
				cands = append(cands, w[i+1:])
			}
			for _, c := range cands {
				c = strings.TrimSuffix(c, "/*")
				if c == "" || strings.HasPrefix(c, "-") {
					continue
				}
				if strings.HasPrefix(c, "~") {
					// a `~user` spelling that survived the first word's expansion (after = or :)
					if s, ok := pr.expandWord(&syntax.Word{Parts: []syntax.WordPart{&syntax.Lit{Value: c}}}); ok {
						c = s
					}
				}
				if filepath.IsAbs(c) {
					add(filepath.Clean(c))
					continue
				}
				for _, cwd := range sw.cwds {
					if cwd != "" {
						add(filepath.Join(cwd, c))
					}
				}
			}
		}
	}
	return out
}

// bashSensitive reports whether a word of the command names an env file the way
// the read tool's own `*.env` card does (`cat .env`, `git show HEAD:.env`).
func (pr Protected) bashSensitive(r Request) bool {
	for _, p := range pr.bashPaths(r) {
		if real, ok := resolve(p); ok && isSensitive(real) {
			return true // a symlink to an env file
		}
	}
	for _, text := range r.commandTexts() {
		for _, w := range pr.shellWords(text, r.Workspace).words {
			for _, c := range []string{w, afterAny(w, ":"), afterAny(w, "=")} {
				if c != "" && isSensitive(c) {
					return true
				}
			}
		}
	}
	return false
}

func afterAny(s, sep string) string {
	if _, rest, ok := strings.Cut(s, sep); ok {
		return rest
	}
	return ""
}

// plainShell reports whether a command line is only simple commands joined by
// | ; && || and newlines: no redirect to a file (only /dev/null and fd
// duplication), no command or process substitution, no background job, here-
// document, subshell, block or function. A stored exception applies only to
// such a line (audit H1): its patterns name the commands that run, and nothing
// else rides along.
func plainShell(src string) bool {
	if strings.TrimSpace(src) == "" {
		return false
	}
	f, err := syntax.NewParser(syntax.Variant(syntax.LangBash)).Parse(strings.NewReader(src), "")
	if err != nil {
		return false
	}
	ok := true
	syntax.Walk(f, func(n syntax.Node) bool {
		switch x := n.(type) {
		case *syntax.CmdSubst, *syntax.ProcSubst, *syntax.Subshell, *syntax.Block, *syntax.FuncDecl,
			*syntax.ArithmExp, *syntax.ArithmCmd, *syntax.CoprocClause, *syntax.IfClause, *syntax.WhileClause,
			*syntax.ForClause, *syntax.CaseClause, *syntax.TestClause, *syntax.DeclClause, *syntax.LetClause,
			*syntax.TimeClause:
			ok = false
		case *syntax.Stmt:
			if x.Background || x.Coprocess {
				ok = false
			}
		case *syntax.Redirect:
			if !okRedirect(x) {
				ok = false
			}
		}
		return ok
	})
	return ok
}
