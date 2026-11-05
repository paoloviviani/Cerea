package decide

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

// ReadOnlyCommand reports whether a `bash` ask is provably a plain read inside
// the workspace (ADR 0107, amendment 2026-11-05). It is computed here, on the
// machine, from the command text alone; nothing an agent supplies in metadata
// takes part. The analysis is deliberately narrow: any parse error or anything
// not understood is "not read-only", which only means the ask keeps its normal
// route (a reviewer, or a card).
//
// Allowed shape: simple commands joined by `|`, `;`, `&&`, `||` or newlines;
// literal words only (no substitution, variable, glob, brace expansion,
// arithmetic, assignment, subshell, block, function or background job); no
// redirect except `>/dev/null`, `2>/dev/null` and `2>&1`; every program on a
// fixed list with its own argument rules; every path argument, symlinks
// resolved, inside the workspace and clear of the Protected lists.
func (p Policy) ReadOnlyCommand(r Request) bool {
	if r.Key != "bash" || r.Workspace == "" || len(r.Patterns) == 0 {
		return false
	}
	if ClassOf(p, r) != ClassCommand {
		return false
	}
	ro := &roCheck{p: p, home: p.Protected.Home}
	ws, err := filepath.EvalSymlinks(r.Workspace)
	if err != nil {
		return false
	}
	ro.ws = filepath.Clean(ws)
	ro.cwd = ro.ws
	for _, cmd := range r.Patterns {
		if !ro.script(cmd) {
			return false
		}
	}
	return true
}

type roCheck struct {
	p        Policy
	home, ws string
	cwd      string
	gitOK    *bool
}

func (ro *roCheck) script(src string) bool {
	if strings.TrimSpace(src) == "" || strings.ContainsRune(src, 0) {
		return false
	}
	f, err := syntax.NewParser(syntax.Variant(syntax.LangBash)).Parse(strings.NewReader(src), "")
	if err != nil || len(f.Stmts) == 0 {
		return false
	}
	for _, st := range f.Stmts {
		if !ro.stmt(st) {
			return false
		}
	}
	return true
}

func (ro *roCheck) stmt(st *syntax.Stmt) bool {
	if st == nil || st.Background || st.Coprocess || st.Negated || st.Cmd == nil {
		return false
	}
	for _, rd := range st.Redirs {
		if !okRedirect(rd) {
			return false
		}
	}
	switch c := st.Cmd.(type) {
	case *syntax.CallExpr:
		return ro.call(c)
	case *syntax.BinaryCmd:
		switch c.Op {
		case syntax.AndStmt, syntax.OrStmt, syntax.Pipe:
			return ro.stmt(c.X) && ro.stmt(c.Y)
		}
	}
	return false
}

func okRedirect(rd *syntax.Redirect) bool {
	if rd.Hdoc != nil {
		return false
	}
	fd := ""
	if rd.N != nil {
		fd = rd.N.Value
	}
	w, ok := literal(rd.Word)
	if !ok {
		return false
	}
	switch rd.Op {
	case syntax.RdrOut:
		return (fd == "" || fd == "1" || fd == "2") && w == "/dev/null"
	case syntax.DplOut:
		return (fd == "2" && w == "1") || (fd == "1" && w == "2")
	}
	return false
}

// literal is the text of a word made only of literal and quoted-literal parts.
// Backslashes are refused outside single quotes, except before ( ) ! which find
// uses; an unquoted glob, brace or `~` anywhere but a leading `~/` is refused,
// because the shell would expand it.
func literal(w *syntax.Word) (string, bool) {
	if w == nil || len(w.Parts) == 0 {
		return "", false
	}
	var sb strings.Builder
	for i, part := range w.Parts {
		switch x := part.(type) {
		case *syntax.Lit:
			v := x.Value
			if strings.ContainsAny(v, "*?[]{}") || strings.ContainsAny(v, "\n") {
				return "", false
			}
			if strings.HasPrefix(v, "~") && i == 0 && !strings.HasPrefix(v, "~/") && v != "~" {
				return "", false
			}
			if strings.Contains(v, "\\") {
				u, ok := unescape(v)
				if !ok {
					return "", false
				}
				v = u
			}
			sb.WriteString(v)
		case *syntax.SglQuoted:
			if x.Dollar || (i == 0 && strings.HasPrefix(x.Value, "~")) {
				return "", false
			}
			sb.WriteString(x.Value)
		case *syntax.DblQuoted:
			if x.Dollar || (i == 0 && len(x.Parts) > 0 && partHasTilde(x.Parts[0])) {
				return "", false
			}
			for _, q := range x.Parts {
				l, ok := q.(*syntax.Lit)
				if !ok || strings.Contains(l.Value, "\\") {
					return "", false
				}
				sb.WriteString(l.Value)
			}
		default:
			return "", false
		}
	}
	return sb.String(), true
}

func unescape(v string) (string, bool) {
	var sb strings.Builder
	for i := 0; i < len(v); i++ {
		if v[i] != '\\' {
			sb.WriteByte(v[i])
			continue
		}
		if i+1 >= len(v) || !strings.ContainsRune("()!", rune(v[i+1])) {
			return "", false
		}
		i++
		sb.WriteByte(v[i])
	}
	return sb.String(), true
}

func (ro *roCheck) call(c *syntax.CallExpr) bool {
	if len(c.Assigns) != 0 || len(c.Args) == 0 {
		return false
	}
	args := make([]string, len(c.Args))
	for i, w := range c.Args {
		s, ok := literal(w)
		if !ok {
			return false
		}
		args[i] = s
	}
	prog, rest := args[0], args[1:]
	if prog == "" || strings.ContainsAny(prog, "/~") {
		return false
	}
	switch prog {
	case "cat":
		return ro.generic(rest, flagSpec{short: "AbeEnstTuv", long: map[string]int{"show-all": 0, "number-nonblank": 0, "show-ends": 0, "number": 0, "squeeze-blank": 0, "show-tabs": 0, "show-nonprinting": 0}}, false)
	case "head":
		return ro.generic(rest, flagSpec{short: "qvz0123456789", shortVal: "nc", long: map[string]int{"lines": 1, "bytes": 1, "quiet": 0, "silent": 0, "verbose": 0, "zero-terminated": 0}}, false)
	case "tail":
		return ro.generic(rest, flagSpec{short: "qvz0123456789", shortVal: "nc", long: map[string]int{"lines": 1, "bytes": 1, "quiet": 0, "silent": 0, "verbose": 0, "zero-terminated": 0}}, false)
	case "wc":
		return ro.generic(rest, flagSpec{short: "clmwL", long: map[string]int{"bytes": 0, "chars": 0, "lines": 0, "words": 0, "max-line-length": 0}}, false)
	case "grep":
		return ro.grep(rest)
	case "ls":
		return ro.generic(rest, flagSpec{short: "aAbBcCdDfFgGhHiklLmnNopqQrsStuUvxXZ1", long: map[string]int{
			"all": 0, "almost-all": 0, "human-readable": 0, "si": 0, "classify": 0, "directory": 0, "reverse": 0,
			"size": 0, "inode": 0, "numeric-uid-gid": 0, "group-directories-first": 0, "literal": 0, "full-time": 0,
			"dereference": 0, "color": 2, "sort": 1, "time": 1, "format": 1}}, false)
	case "df":
		return ro.generic(rest, flagSpec{short: "aBhHiklPT", shortVal: "tx", long: map[string]int{"all": 0, "human-readable": 0, "si": 0,
			"inodes": 0, "local": 0, "portability": 0, "print-type": 0, "total": 0, "type": 1, "exclude-type": 1, "block-size": 1}}, false)
	case "du":
		return ro.generic(rest, flagSpec{short: "abchHklLmsSxP", shortVal: "dB", long: map[string]int{"all": 0, "apparent-size": 0, "bytes": 0,
			"total": 0, "human-readable": 0, "si": 0, "summarize": 0, "max-depth": 1, "one-file-system": 0, "dereference": 0,
			"count-links": 0, "separate-dirs": 0, "block-size": 1}}, false)
	case "ps":
		return ro.ps(rest)
	case "find":
		return ro.find(rest)
	case "sed":
		return ro.sed(rest)
	case "git":
		return ro.git(rest)
	case "docker":
		return ro.docker(rest)
	case "systemctl":
		return ro.systemctl(rest)
	case "journalctl":
		return ro.journalctl(rest)
	}
	return false
}

// flagSpec is what a program accepts: boolean short letters, short letters that
// take a value, and long flags (0 boolean, 1 takes a value either way, 2 takes
// one only as --name=value). Anything not named is refused.
type flagSpec struct {
	short, shortVal string
	long            map[string]int
}

// parse walks args. Non-flag arguments are returned in order (a value taken by
// a flag is not among them); ok is false on any flag the spec does not name.
// Values the flags took are returned in vals, keyed by flag name, in order.
func (s flagSpec) parse(args []string) (pos []string, vals map[string][]string, ok bool) {
	vals = map[string][]string{}
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--":
			return append(pos, args[i+1:]...), vals, true
		case strings.HasPrefix(a, "--"):
			name, val, hasVal := strings.Cut(a[2:], "=")
			kind, known := s.long[name]
			if !known {
				return nil, nil, false
			}
			switch {
			case kind == 0 && hasVal:
				return nil, nil, false
			case kind == 1 && !hasVal:
				if i+1 >= len(args) {
					return nil, nil, false
				}
				i++
				val = args[i]
			}
			if kind != 0 {
				vals[name] = append(vals[name], val)
			}
		case strings.HasPrefix(a, "-") && len(a) > 1:
			for j := 1; j < len(a); j++ {
				c := a[j]
				switch {
				case strings.IndexByte(s.short, c) >= 0:
				case strings.IndexByte(s.shortVal, c) >= 0:
					v := a[j+1:]
					if v == "" {
						if i+1 >= len(args) {
							return nil, nil, false
						}
						i++
						v = args[i]
					}
					vals[string(c)] = append(vals[string(c)], v)
					j = len(a)
				default:
					return nil, nil, false
				}
			}
		default:
			pos = append(pos, a)
		}
	}
	return pos, vals, true
}

// generic checks a program whose every positional is a path (or, with
// noPaths, a name that is not one).
func (ro *roCheck) generic(args []string, s flagSpec, noPaths bool) bool {
	pos, _, ok := s.parse(args)
	if !ok {
		return false
	}
	return noPaths || ro.paths(pos)
}

func (ro *roCheck) grep(args []string) bool {
	s := flagSpec{short: "iIvwxcLlnHhbosqaEFGPTzZUV0123456789", shortVal: "emABC", long: map[string]int{
		"ignore-case": 0, "no-ignore-case": 0, "invert-match": 0, "word-regexp": 0, "line-regexp": 0, "count": 0,
		"files-with-matches": 0, "files-without-match": 0, "line-number": 0, "with-filename": 0, "no-filename": 0,
		"only-matching": 0, "quiet": 0, "silent": 0, "no-messages": 0, "text": 0, "extended-regexp": 0,
		"fixed-strings": 0, "basic-regexp": 0, "perl-regexp": 0, "null": 0, "initial-tab": 0, "byte-offset": 0,
		"null-data": 0, "line-buffered": 0, "max-count": 1, "after-context": 1, "before-context": 1, "context": 1,
		"regexp": 1, "color": 2, "colour": 2, "binary": 0}}
	pos, vals, ok := s.parse(args)
	if !ok {
		return false
	}
	if len(vals["e"]) == 0 && len(vals["regexp"]) == 0 {
		if len(pos) == 0 {
			return false
		}
		pos = pos[1:]
	}
	return ro.paths(pos)
}

var psWord = regexp.MustCompile(`^[A-Za-z0-9,._=:%-]+$`)

func (ro *roCheck) ps(args []string) bool {
	for _, a := range args {
		l := strings.ToLower(a)
		if strings.Contains(l, "env") || a == "--" {
			return false
		}
		if strings.HasPrefix(a, "-") {
			if !psWord.MatchString(strings.TrimLeft(a, "-")) {
				return false
			}
			continue
		}
		// a BSD-style word: `e` there prints each process's environment
		if !psWord.MatchString(a) || strings.ContainsAny(a, "eE") && regexp.MustCompile(`^[A-Za-z]+$`).MatchString(a) {
			return false
		}
	}
	return true
}

var findZero = map[string]bool{"-print": true, "-print0": true, "-empty": true, "-prune": true, "-a": true, "-o": true,
	"-and": true, "-or": true, "-not": true, "!": true, "(": true, ")": true, "-true": true, "-false": true,
	"-readable": true, "-writable": true, "-executable": true, "-ls": true, "-depth": true, "-xdev": true, "-mount": true}
var findVal = map[string]bool{"-name": true, "-iname": true, "-path": true, "-ipath": true, "-wholename": true,
	"-lname": true, "-ilname": true, "-type": true, "-maxdepth": true, "-mindepth": true, "-mtime": true,
	"-atime": true, "-ctime": true, "-mmin": true, "-amin": true, "-cmin": true, "-size": true, "-user": true,
	"-group": true, "-perm": true, "-regex": true, "-iregex": true, "-links": true, "-inum": true, "-uid": true,
	"-gid": true}

func (ro *roCheck) find(args []string) bool {
	i := 0
	var starts []string
	for ; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "-") || a == "(" || a == "!" || a == ")" {
			break
		}
		starts = append(starts, a)
	}
	if len(starts) == 0 {
		starts = []string{"."}
	}
	if !ro.paths(starts) {
		return false
	}
	for ; i < len(args); i++ {
		a := args[i]
		switch {
		case findZero[a]:
		case findVal[a]:
			i++
			if i >= len(args) {
				return false
			}
		case a == "-newer" || a == "-samefile":
			i++
			if i >= len(args) || !ro.paths(args[i:i+1]) {
				return false
			}
		default:
			return false
		}
	}
	return true
}

var sedAddr = regexp.MustCompile(`^(\d+|\$)(,(\d+|\$))?!?`)

func (ro *roCheck) sed(args []string) bool {
	s := flagSpec{short: "nEsrz", shortVal: "e", long: map[string]int{"quiet": 0, "silent": 0, "regexp-extended": 0,
		"separate": 0, "null-data": 0, "expression": 1}}
	pos, vals, ok := s.parse(args)
	if !ok {
		return false
	}
	scripts := append(append([]string{}, vals["e"]...), vals["expression"]...)
	if len(scripts) == 0 {
		if len(pos) == 0 {
			return false
		}
		scripts, pos = pos[:1], pos[1:]
	}
	for _, sc := range scripts {
		if !safeSed(sc) {
			return false
		}
	}
	return ro.paths(pos)
}

// safeSed accepts only `p`, `d`, `q`, `=` and `s///` with the flags g p i I and
// digits, each with an optional line or regexp address, separated by `;`: no
// w, e, r or any other command that writes a file or runs something.
func safeSed(sc string) bool {
	i := 0
	for {
		for i < len(sc) && (sc[i] == ' ' || sc[i] == ';') {
			i++
		}
		if i >= len(sc) {
			return true
		}
		if m := sedAddr.FindString(sc[i:]); m != "" {
			i += len(m)
		} else if sc[i] == '/' {
			j := closing(sc, i+1, '/')
			if j < 0 {
				return false
			}
			i = j + 1
			if i < len(sc) && sc[i] == '!' {
				i++
			}
		}
		for i < len(sc) && sc[i] == ' ' {
			i++
		}
		if i >= len(sc) {
			return false
		}
		switch sc[i] {
		case 'p', 'd', 'q', '=':
			i++
		case 's':
			if i+1 >= len(sc) {
				return false
			}
			d := sc[i+1]
			if d == '\\' || d == '\n' || d == ';' || d == ' ' || (d >= '0' && d <= '9') || (d|0x20 >= 'a' && d|0x20 <= 'z') {
				return false
			}
			j := closing(sc, i+2, d)
			if j < 0 {
				return false
			}
			k := closing(sc, j+1, d)
			if k < 0 {
				return false
			}
			i = k + 1
			for i < len(sc) && strings.IndexByte("gpiI0123456789", sc[i]) >= 0 {
				i++
			}
		default:
			return false
		}
		if i < len(sc) && sc[i] != ';' && sc[i] != ' ' {
			return false
		}
	}
}

// closing is the index of the next unescaped d at or after from, or -1.
func closing(s string, from int, d byte) int {
	for i := from; i < len(s); i++ {
		switch s[i] {
		case '\\':
			i++
		case d:
			return i
		}
	}
	return -1
}

var gitDeny = []string{"--output", "-o", "--ext-diff", "--exec-path", "-c", "-C", "--no-index", "--paginate",
	"--open-files-in-pager", "-O", "--git-dir", "--work-tree", "--config-env", "--upload-pack", "--exec",
	"--namespace", "--super-prefix", "--textconv", "--ext", "--show-signature", "--verify", "--gpg"}

func (ro *roCheck) git(args []string) bool {
	if len(args) == 0 {
		return false
	}
	switch args[0] {
	case "status", "log", "diff", "show":
	default:
		return false
	}
	if !ro.gitConfigSafe() {
		return false
	}
	afterDD := false
	for _, a := range args[1:] {
		if a == "--" {
			afterDD = true
			continue
		}
		if afterDD {
			if !ro.paths([]string{a}) {
				return false
			}
			continue
		}
		if strings.HasPrefix(a, "-") {
			for _, d := range gitDeny {
				if strings.HasPrefix(d, "--") && strings.HasPrefix(a, d) {
					return false
				}
				if !strings.HasPrefix(d, "--") && strings.HasPrefix(a, d) {
					return false
				}
			}
			continue
		}
		// a revision or a path: check it as a path when it looks like one or exists
		if strings.ContainsAny(a, "/~") || strings.HasPrefix(a, ".") || ro.exists(a) {
			if strings.Contains(a, ":") && !ro.exists(a) {
				continue // REV:path names an object, not a file
			}
			if !ro.paths([]string{a}) {
				return false
			}
		}
	}
	return true
}

func (ro *roCheck) exists(a string) bool {
	_, err := os.Lstat(ro.abs(a))
	return err == nil
}

var nameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.@:\\-]*$`)

func names(pos []string) bool {
	for _, p := range pos {
		if !nameRe.MatchString(p) {
			return false
		}
	}
	return true
}

func (ro *roCheck) docker(args []string) bool {
	if len(args) == 0 {
		return false
	}
	switch args[0] {
	case "ps":
		pos, _, ok := flagSpec{short: "aqls", shortVal: "nf", long: map[string]int{"all": 0, "quiet": 0, "latest": 0, "last": 1,
			"no-trunc": 0, "size": 0, "filter": 1, "format": 1}}.parse(args[1:])
		return ok && len(pos) == 0
	case "logs":
		pos, _, ok := flagSpec{short: "t", shortVal: "n", long: map[string]int{"tail": 1, "since": 1, "until": 1,
			"timestamps": 0, "details": 0}}.parse(args[1:])
		return ok && len(pos) > 0 && names(pos)
	case "compose":
		if len(args) < 2 {
			return false
		}
		switch args[1] {
		case "ps":
			pos, _, ok := flagSpec{short: "aq", long: map[string]int{"all": 0, "quiet": 0, "services": 0, "status": 1,
				"format": 1, "filter": 1, "no-trunc": 0}}.parse(args[2:])
			return ok && names(pos)
		case "logs":
			pos, _, ok := flagSpec{short: "t", shortVal: "n", long: map[string]int{"tail": 1, "since": 1, "until": 1,
				"timestamps": 0, "no-color": 0, "no-log-prefix": 0}}.parse(args[2:])
			return ok && names(pos)
		}
	}
	return false
}

func (ro *roCheck) systemctl(args []string) bool {
	if len(args) == 0 || args[0] != "status" {
		return false
	}
	pos, _, ok := flagSpec{short: "ln", shortVal: "", long: map[string]int{"full": 0, "no-pager": 0, "user": 0, "system": 0,
		"lines": 1}}.parse(args[1:])
	return ok && names(pos)
}

var fieldRe = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*=[^\s]*$`)

func (ro *roCheck) journalctl(args []string) bool {
	pos, _, ok := flagSpec{short: "rxkbqeaS", shortVal: "unpoStUgtn", long: map[string]int{
		"unit": 1, "user-unit": 1, "lines": 1, "priority": 1, "output": 1, "since": 1, "until": 1, "grep": 1,
		"identifier": 1, "reverse": 0, "no-pager": 0, "boot": 2, "dmesg": 0, "utc": 0, "quiet": 0, "no-hostname": 0,
		"user": 0, "system": 0, "all": 0, "catalog": 0, "pager-end": 0, "case-sensitive": 2, "output-fields": 1}}.parse(args)
	if !ok {
		return false
	}
	for _, p := range pos {
		if !fieldRe.MatchString(p) {
			return false
		}
	}
	return true
}

// abs is a path argument made absolute against the command's directory.
func (ro *roCheck) abs(a string) string {
	switch {
	case a == "~" && ro.home != "":
		return ro.home
	case strings.HasPrefix(a, "~/") && ro.home != "":
		return filepath.Join(ro.home, a[2:])
	case filepath.IsAbs(a):
		return filepath.Clean(a)
	}
	return filepath.Join(ro.cwd, a)
}

// paths: every argument that is not "-" (stdin) resolves inside the workspace
// and clear of the secret and own lists.
func (ro *roCheck) paths(pos []string) bool {
	for _, a := range pos {
		if a == "-" {
			continue
		}
		if a == "" || strings.HasPrefix(a, "~") && ro.home == "" {
			return false
		}
		real, ok := resolve(ro.abs(a))
		if !ok || !under(ro.ws, real) {
			return false
		}
		if isSensitive(real) || isSensitive(a) {
			return false
		}
		rq := Request{Key: "read", Patterns: []string{real, ro.abs(a)}, Workspace: ro.ws}
		if _, hit := ro.p.Protected.SecretHit(rq); hit {
			return false
		}
		if _, hit := ro.p.Protected.OwnHit(rq); hit {
			return false
		}
	}
	return true
}

// resolve follows symlinks of the longest existing prefix of p and appends the
// rest, so a path that does not exist yet is still judged by where it would be.
func resolve(p string) (string, bool) {
	p = filepath.Clean(p)
	rest := ""
	for cur := p; ; cur = filepath.Dir(cur) {
		real, err := filepath.EvalSymlinks(cur)
		if err == nil {
			return filepath.Join(real, rest), true
		}
		if !os.IsNotExist(err) || cur == filepath.Dir(cur) {
			return "", false
		}
		rest = filepath.Join(filepath.Base(cur), rest)
	}
}

func partHasTilde(n syntax.WordPart) bool {
	l, ok := n.(*syntax.Lit)
	return ok && strings.HasPrefix(l.Value, "~")
}

// gitRisky are the words that, anywhere in a repository's local config, could
// make `git status|log|diff|show` run a program: a filesystem monitor, a pager,
// an external diff or textconv, a clean/smudge filter, a signature verifier
// (gpg.program), an ssh or askpass command, hooks, or an include of another
// file. It is a lenient substring match on the lowercased text on purpose: any
// odd spelling that contains one is refused.
var gitRisky = []string{"include", "fsmonitor", "pager", "external", "textconv", "filter", "gpg", "showsignature",
	"sshcommand", "askpass", "editor", "hookspath", "command", "program", "process", "smudge", "clean", "[alias"}

// gitConfigSafe reports whether the repository the command would run in has a
// local config none of whose text names something that executes (agents can
// write .git/config, and edits run unreviewed). The repository is found the way
// git finds it, upward from the working directory; its config, the worktree
// config and a linked worktree's common config are all read. A config that
// cannot be read, or is odd, is not safe. Global and system config are the
// user's own and are not examined. No repository at all is fine.
func (ro *roCheck) gitConfigSafe() bool {
	if ro.gitOK != nil {
		return *ro.gitOK
	}
	ok := ro.gitConfigScan()
	ro.gitOK = &ok
	return ok
}

func (ro *roCheck) gitConfigScan() bool {
	dir := ro.cwd
	var gitdir string
	for {
		fi, err := os.Lstat(filepath.Join(dir, ".git"))
		if err == nil {
			g := filepath.Join(dir, ".git")
			if fi.IsDir() {
				gitdir = g
			} else if fi.Mode().IsRegular() {
				b, err := os.ReadFile(g)
				if err != nil || len(b) > 4096 {
					return false
				}
				line, found := strings.CutPrefix(strings.TrimSpace(string(b)), "gitdir:")
				if !found {
					return false
				}
				line = strings.TrimSpace(line)
				if !filepath.IsAbs(line) {
					line = filepath.Join(dir, line)
				}
				gitdir = filepath.Clean(line)
			} else {
				return false // a symlink or something else: not understood
			}
			break
		} else if !os.IsNotExist(err) {
			return false
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return true // not in a repository
		}
		dir = parent
	}
	files := []string{filepath.Join(gitdir, "config"), filepath.Join(gitdir, "config.worktree")}
	if b, err := os.ReadFile(filepath.Join(gitdir, "commondir")); err == nil {
		c := strings.TrimSpace(string(b))
		if c == "" || len(b) > 4096 {
			return false
		}
		if !filepath.IsAbs(c) {
			c = filepath.Join(gitdir, c)
		}
		c = filepath.Clean(c)
		files = append(files, filepath.Join(c, "config"), filepath.Join(c, "config.worktree"))
	} else if !os.IsNotExist(err) {
		return false
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil || len(b) > 1<<20 {
			return false
		}
		text := strings.ToLower(string(b))
		for _, w := range gitRisky {
			if strings.Contains(text, w) {
				return false
			}
		}
	}
	return true
}
