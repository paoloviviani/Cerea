package decide

import (
	"os/user"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"mvdan.cc/sh/v3/expand"
	"mvdan.cc/sh/v3/syntax"
)

// Bash is judged on the command text, not only on opencode's `patterns` (audit
// H1, M1): the text is parsed with mvdan/sh, the way the read-only rule does,
// and every word is a candidate path. Words are expanded for the spellings a
// shell gives them (`~`, `~user`, `$HOME`, `${HOME}`, variables the line itself
// assigns, braces and globs), resolved against the working directory the
// command has reached (`cd X && cat y` tracks X), and compared as paths
// (case-folded on macOS, symlinks resolved). What cannot be expanded is judged
// conservatively: a word with an expansion it cannot follow that names a
// protected place is a hit, a glob that could match a protected path is a hit,
// and a line too large to check, or one that sets CDPATH, is a card.

// Limits of the analysis; over them the line is a card, never a pass.
const (
	maxWords = 256
	maxCwds  = 16
	maxGlobs = 64
)

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

// bashAnalysis is what the parser found in a request's texts, computed once.
type bashAnalysis struct {
	words    []string // expanded words, deduplicated
	unknown  []string // literal text of words with an expansion that could not be followed
	globs    []string // absolute glob patterns (word x cwd)
	paths    []string // absolute paths the words can name, and their symlink-resolved forms
	cdpath   bool     // the line sets CDPATH: cd targets are unknown
	overflow bool     // the line is too large to check
}

type cachedAnalysis struct {
	a    *bashAnalysis
	when time.Time
}

var (
	analysisMu    sync.Mutex
	analysisCache = map[string]cachedAnalysis{}
)

const analysisTTL = 3 * time.Second

// analysis returns the (cached) analysis of a bash request. One decision asks
// the same question several times (class, secrets, own files, read-only), so
// the parsing and the symlink resolution are done once per request; the short
// lifetime keeps a changed symlink from being trusted for long.
func (pr Protected) analysis(r Request) *bashAnalysis {
	key := strings.Join(append([]string{pr.Home, r.Workspace, r.Command}, r.Patterns...), "\x00")
	now := time.Now()
	analysisMu.Lock()
	if c, ok := analysisCache[key]; ok && now.Sub(c.when) < analysisTTL {
		analysisMu.Unlock()
		return c.a
	}
	analysisMu.Unlock()
	a := pr.analyze(r)
	analysisMu.Lock()
	if len(analysisCache) >= 128 {
		analysisCache = map[string]cachedAnalysis{}
	}
	analysisCache[key] = cachedAnalysis{a, now}
	analysisMu.Unlock()
	return a
}

var rangeRe = regexp.MustCompile(`\{(-?\d+)\.\.(-?\d+)`)

func (pr Protected) analyze(r Request) *bashAnalysis {
	a := &bashAnalysis{}
	words := map[string]bool{}
	unknown := map[string]bool{}
	cwdSet := map[string]bool{}
	var cwds []string
	addCwd := func(c string) {
		if c != "" && !cwdSet[c] {
			cwdSet[c] = true
			cwds = append(cwds, c)
		}
	}
	addCwd(r.Workspace)
	var globWords []string
	for _, text := range r.commandTexts() {
		f, err := syntax.NewParser(syntax.Variant(syntax.LangBash)).Parse(strings.NewReader(text), "")
		if err != nil {
			continue
		}
		vars := map[string]string{}
		cur := r.Workspace
		assign := func(as []*syntax.Assign) {
			for _, as := range as {
				if as.Name == nil {
					continue
				}
				if as.Name.Value == "CDPATH" {
					a.cdpath = true
				}
				if as.Value == nil {
					continue
				}
				if s, ex := pr.expandWord(as.Value, vars); ex.ok() {
					vars[as.Name.Value] = s
					words[s] = true
				} else {
					delete(vars, as.Name.Value)
				}
			}
		}
		syntax.Walk(f, func(n syntax.Node) bool {
			switch x := n.(type) {
			case *syntax.DeclClause:
				assign(x.Args)
				return true
			case *syntax.CallExpr:
				// a prefix assignment is seen by the command's own words
				scope := vars
				if len(x.Args) > 0 && len(x.Assigns) > 0 {
					scope = map[string]string{}
					for k, v := range vars {
						scope[k] = v
					}
				}
				for _, as := range x.Assigns {
					if as.Name != nil && as.Name.Value == "CDPATH" {
						a.cdpath = true
					}
					if as.Name != nil && as.Value != nil {
						if s, ex := pr.expandWord(as.Value, vars); ex.ok() {
							scope[as.Name.Value] = s
							words[s] = true
						}
					}
				}
				if len(x.Args) == 0 {
					assign(x.Assigns)
					return true
				}
				var args []string
				for _, w := range x.Args {
					if bracesTooBig(w) {
						a.overflow = true
						continue
					}
					// split braces on a copy: the walk must not see the rewritten tree
					cp := &syntax.Word{Parts: append([]syntax.WordPart(nil), w.Parts...)}
					syntax.SplitBraces(cp)
					for _, bw := range expand.Braces(cp) {
						s, ex := pr.expandWord(bw, scope)
						switch {
						case !ex.ok():
							if lit := ex.lit; lit != "" {
								unknown[lit] = true
							}
						case ex.glob:
							globWords = append(globWords, s)
							args = append(args, s)
						default:
							words[s] = true
							args = append(args, s)
						}
					}
				}
				if len(args) >= 1 && (args[0] == "cd" || args[0] == "pushd") {
					target := pr.Home
					if len(args) >= 2 && !strings.HasPrefix(args[len(args)-1], "-") {
						target = args[len(args)-1]
					}
					if target != "" && cur != "" {
						cur = pr.joinCwd(cur, target)
						addCwd(cur)
					}
				}
			}
			return true
		})
	}
	if len(words) > maxWords || len(cwds) > maxCwds || len(globWords) > maxGlobs || len(unknown) > maxWords {
		a.overflow = true
		return a
	}
	for w := range words {
		a.words = append(a.words, w)
	}
	for w := range unknown {
		a.unknown = append(a.unknown, w)
	}
	seen := map[string]bool{}
	add := func(p string) {
		if p == "" || seen[p] {
			return
		}
		seen[p] = true
		a.paths = append(a.paths, p)
		if real, ok := resolve(p); ok && real != p && !seen[real] {
			seen[real] = true
			a.paths = append(a.paths, real)
		}
	}
	for _, w := range a.words {
		for _, c := range pathCandidates(w) {
			if filepath.IsAbs(c) {
				add(filepath.Clean(c))
				continue
			}
			for _, cwd := range cwds {
				if cwd != "" {
					add(filepath.Join(cwd, c))
				}
			}
		}
	}
	gseen := map[string]bool{}
	for _, g := range globWords {
		for _, c := range pathCandidates(g) {
			var pats []string
			if filepath.IsAbs(c) {
				pats = []string{filepath.Clean(c)}
			} else {
				for _, cwd := range cwds {
					if cwd != "" {
						pats = append(pats, filepath.Join(cwd, c))
					}
				}
			}
			for _, p := range pats {
				if gseen[p] {
					continue
				}
				gseen[p] = true
				a.globs = append(a.globs, p)
				if ms, err := filepath.Glob(p); err == nil {
					if len(ms) > 64 {
						ms = ms[:64]
					}
					for _, m := range ms {
						add(m)
					}
				}
			}
		}
	}
	return a
}

// bracesTooBig refuses a brace expansion that would explode (`{1..99999}`,
// deeply nested lists): the line is then too large to check.
func bracesTooBig(w *syntax.Word) bool {
	var sb strings.Builder
	for _, p := range w.Parts {
		if l, ok := p.(*syntax.Lit); ok {
			sb.WriteString(l.Value)
		}
	}
	s := sb.String()
	if strings.Count(s, "{") > 3 {
		return true
	}
	for _, m := range rangeRe.FindAllStringSubmatch(s, -1) {
		lo, _ := strconv.Atoi(m[1])
		hi, _ := strconv.Atoi(m[2])
		if hi-lo > 100 || lo-hi > 100 {
			return true
		}
	}
	return false
}

// pathCandidates are the paths a word can name: itself, and the path half of a
// `REV:path` or `--opt=path` word.
func pathCandidates(w string) []string {
	cands := []string{w}
	if i := strings.IndexAny(w, "=:"); i > 0 && i+1 < len(w) {
		cands = append(cands, w[i+1:])
	}
	out := cands[:0:0]
	for _, c := range cands {
		c = strings.TrimSuffix(c, "/*")
		if c == "" || strings.HasPrefix(c, "-") {
			continue
		}
		out = append(out, c)
	}
	return out
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

// wordExp says what became of a word's expansion.
type wordExp struct {
	bad  bool   // an expansion that could not be followed
	glob bool   // an unquoted glob character
	lit  string // for a bad word, its literal text
}

func (e wordExp) ok() bool { return !e.bad }

// expandWord is a word's text with `~`, `~user`, `$HOME`, `${HOME}` and the
// simple variables the line assigned expanded.
func (pr Protected) expandWord(w *syntax.Word, vars map[string]string) (string, wordExp) {
	var sb, lit strings.Builder
	var ex wordExp
	var emit func(parts []syntax.WordPart, first, quoted bool)
	emit = func(parts []syntax.WordPart, first, quoted bool) {
		for i, part := range parts {
			switch x := part.(type) {
			case *syntax.Lit:
				v := x.Value
				if first && i == 0 && !quoted && strings.HasPrefix(v, "~") {
					name, rest, _ := strings.Cut(v[1:], "/")
					home := pr.homeOf(name)
					if home == "" {
						ex.bad = true
						lit.WriteString(v)
						continue
					}
					nv := home
					if rest != "" || strings.Contains(v, "/") {
						nv += "/" + rest
					}
					v = nv
				}
				v = strings.ReplaceAll(v, `\`, "")
				if !quoted && strings.ContainsAny(v, "*?[") {
					ex.glob = true
				}
				sb.WriteString(v)
				lit.WriteString(v)
			case *syntax.SglQuoted:
				sb.WriteString(x.Value)
				lit.WriteString(x.Value)
			case *syntax.DblQuoted:
				emit(x.Parts, false, true)
			case *syntax.ParamExp:
				name := ""
				if x.Param != nil {
					name = x.Param.Value
				}
				simple := x.Exp == nil && !x.Length && !x.Width && x.Index == nil && x.Slice == nil && x.Repl == nil && !x.Excl
				switch {
				case simple && name == "HOME" && pr.Home != "":
					sb.WriteString(pr.Home)
					lit.WriteString(pr.Home)
				case simple && vars != nil && hasVar(vars, name):
					sb.WriteString(vars[name])
					lit.WriteString(vars[name])
				default:
					ex.bad = true
				}
			default:
				ex.bad = true
			}
		}
	}
	if w == nil {
		return "", wordExp{bad: true}
	}
	emit(w.Parts, true, false)
	if ex.bad {
		ex.lit = lit.String()
		return "", ex
	}
	return sb.String(), ex
}

func hasVar(vars map[string]string, name string) bool {
	_, ok := vars[name]
	return ok
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

// bashUnknown reports a line the analysis cannot vouch for: too large to
// check, or one that sets CDPATH (which changes where `cd` goes). It is a card.
func (pr Protected) bashUnknown(r Request) (string, bool) {
	a := pr.analysis(r)
	switch {
	case a.overflow:
		return "command too large to check for secret paths", true
	case a.cdpath:
		return "command sets CDPATH, so where cd goes is unknown", true
	}
	return "", false
}

// bashSensitive reports whether a word of the command names an env file the way
// the read tool's own `*.env` card does (`cat .env`, `git show HEAD:.env`), or
// the line is one the analysis cannot vouch for.
func (pr Protected) bashSensitive(r Request) bool {
	a := pr.analysis(r)
	if a.overflow || a.cdpath {
		return true
	}
	for _, p := range a.paths {
		if isSensitive(p) {
			return true // also a symlink to an env file
		}
	}
	for _, w := range a.words {
		for _, c := range []string{w, afterAny(w, ":"), afterAny(w, "=")} {
			if c != "" && isSensitive(c) {
				return true
			}
		}
	}
	for _, g := range a.globs {
		if isSensitive(g) || strings.Contains(path.Base(g), "env") && globMatches(g, ".env") {
			return true
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

// globMatches reports whether the last element of a glob pattern matches name.
func globMatches(pattern, name string) bool {
	ok, _ := path.Match(path.Base(pattern), name)
	return ok
}

// globCouldReach reports whether a glob pattern could match a path in or under
// dir, or an ancestor of it: the segments are compared one by one for as long as
// both have one. Conservative by design.
func (pr Protected) globCouldReach(pattern, dir string) bool {
	ps := strings.Split(strings.Trim(pr.cmp(filepath.ToSlash(pattern)), "/"), "/")
	ds := strings.Split(strings.Trim(pr.cmp(filepath.ToSlash(dir)), "/"), "/")
	n := len(ps)
	if len(ds) < n {
		n = len(ds)
	}
	if n == 0 {
		return false
	}
	for i := 0; i < n; i++ {
		if ok, _ := path.Match(ps[i], ds[i]); !ok {
			return false
		}
	}
	return true
}

// unknownReaches reports whether the literal text of a word with an expansion
// that could not be followed names a protected place under the home directory
// (`${HOME%/}/.ssh/id_rsa`).
func (pr Protected) unknownReaches(lit string, dirs []string) (string, bool) {
	h := pr.Home
	if h == "" {
		return "", false
	}
	text := pr.cmp(lit)
	for _, d := range dirs {
		if !strings.HasPrefix(d, h+"/") {
			continue
		}
		rel := pr.cmp(strings.TrimPrefix(d, h+"/"))
		if strings.HasPrefix(text, rel) || strings.Contains(text, "/"+rel) {
			return d, true
		}
	}
	return "", false
}

// plainEnv are the environment assignments a plain command line may carry: they
// change no program that runs.
var plainEnv = map[string]bool{"LC_ALL": true, "LANG": true, "TZ": true, "NO_COLOR": true, "CI": true, "FORCE_COLOR": true}

// plainShell reports whether a command line is only simple commands joined by
// | ; && || and newlines: no redirect to a file (only /dev/null and fd
// duplication), no command or process substitution, no background job, here-
// document, subshell, block or function, and no environment assignment outside
// a tiny allowlist (GIT_SSH_COMMAND, PAGER, LD_PRELOAD and the like run code).
// A stored exception applies only to such a line (audit H1): its patterns name
// the commands that run, and nothing else rides along.
func plainShell(src string) bool {
	_, ok := plainCalls(src)
	return ok
}

// plainCalls is plainShell and, when the line is plain, the text of each simple
// command in it, for matching an exception against every one of them.
func plainCalls(src string) ([]string, bool) {
	if strings.TrimSpace(src) == "" {
		return nil, false
	}
	f, err := syntax.NewParser(syntax.Variant(syntax.LangBash)).Parse(strings.NewReader(src), "")
	if err != nil {
		return nil, false
	}
	ok := true
	var calls []string
	pr := syntax.NewPrinter()
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
		case *syntax.CallExpr:
			for _, as := range x.Assigns {
				if as.Name == nil || !plainEnv[as.Name.Value] {
					ok = false
				}
			}
			if len(x.Args) == 0 {
				ok = false
			}
			var sb strings.Builder
			if err := pr.Print(&sb, x); err != nil {
				ok = false
			}
			calls = append(calls, sb.String())
		}
		return ok
	})
	return calls, ok
}
