package decide

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// The secret-value guard (C73). Before an outbound command or a tool call runs,
// its text is checked for the VALUE of a secret this machine holds locally: the
// values in the workspace's .env* files and in the credential files of the
// secrets class (Protected.SecretDirs). A hit is a card that always reaches the
// user, whatever the session's word and whatever a limit or exception says; the
// card names the key and its file, never the value.
//
// It guards against a careless agent (ADR 0107's threat model), not against a
// hostile one: it matches the value and its common encodings, nothing cleverer.
// Values are read on demand from the files, kept in a small mtime-checked cache
// in memory only, and never logged, sent or written anywhere.

// SecretLeak says which secret a text carries: the key's name and the file it is
// in (workspace-relative, or ~/ form). Never the value.
type SecretLeak struct {
	Key  string
	File string
}

const (
	// minSecretValue is the shortest value compared: shorter ones match too much.
	minSecretValue = 12
	// maxSecretFile is the largest file parsed for values.
	maxSecretFile = 64 << 10
	// maxSecretFiles bounds the files looked at for one check.
	maxSecretFiles = 300
	// maxSecretText bounds the text searched.
	maxSecretText = 1 << 20
)

// SecretValueLeak reports whether the request's text carries the value of a
// known local secret. Only an outbound command (bash) and a tool or web call
// are checked; any other request returns nil.
func (pr Protected) SecretValueLeak(r Request) *SecretLeak {
	var text string
	switch r.Key {
	case "bash":
		text = strings.Join(r.commandTexts(), "\n")
		if !outbound(text) {
			return nil
		}
		if l := pr.outboundFileLeak(r); l != nil {
			return l
		}
	case "read", "glob", "grep", "list", "lsp", "skill", "edit", "external_directory", "task", "todowrite",
		"todoread", "question", "plan_enter", "plan_exit", "doom_loop", "session_list", "session_read",
		"session_send", "session_spawn", "schedule":
		return nil
	default: // webfetch, websearch, codesearch and every MCP or unknown tool
		text = strings.Join(r.Patterns, "\n") + "\n" + r.Args
	}
	if len(text) < minSecretValue {
		return nil
	}
	if len(text) > maxSecretText {
		text = text[:maxSecretText]
	}
	for _, e := range pr.secretEntries(r.Workspace) {
		for _, n := range e.needles {
			if strings.Contains(text, n) {
				return &SecretLeak{Key: e.key, File: e.file}
			}
		}
	}
	return nil
}

// outboundFileLeak is the other half of the guard, for a line that sends
// something off the machine: if it also names a .env-ish file anywhere (a word, a
// curl `@file` argument, a redirect, the left side of a pipe, a symlink to one, a
// glob that can match one), or contains a word the analysis could not follow that
// could be one, it is a card in every mode, like a secret's value in its text. A
// credential store's path is already a card in every mode (SecretHit). The names
// are never values. It cannot see a program that reads the file and sends it
// itself (a script, `npm publish` of a folder holding a .env).
func (pr Protected) outboundFileLeak(r Request) *SecretLeak {
	a := pr.analysis(r)
	file := func(c string) *SecretLeak {
		return &SecretLeak{Key: fileLeakKey, File: filepath.Base(c)}
	}
	for _, w := range a.words {
		if c := namedIn(w); c != "" {
			return file(c)
		}
	}
	var urlTails []string // `//host/path` of each URL word: what a path candidate of it looks like
	for _, w := range a.words {
		if strings.Contains(w, "://") {
			urlTails = append(urlTails, filepath.Clean(afterAny(w, ":")))
		}
	}
	isURL := func(p string) bool {
		if urlPath.MatchString(p) {
			return true
		}
		for _, t := range urlTails {
			if strings.HasSuffix(p, t) {
				return true
			}
		}
		return false
	}
	for _, p := range a.paths {
		if isURL(p) { // a URL joined to a directory
			continue
		}
		if isSensitive(p) { // also a symlink to an env file
			return file(p)
		}
	}
	for _, g := range a.globs {
		base := path.Base(g)
		for _, c := range outVariants(base) {
			// a dotfile pattern that can match an env file (`.e*`, `.*`); a shell's `*` leaves dotfiles alone
			if isSensitive(c) || strings.HasPrefix(c, ".") && (globMatches(c, ".env") || globMatches(c, ".env.local")) {
				return file(c)
			}
		}
	}
	// a word it cannot follow: its literal text may name an env file, or end in a
	// `@` / `<` that makes the rest a file reference built at run time
	for _, u := range a.unknown {
		if c := namedIn(u); c != "" {
			return file(c)
		}
		if blindFileRef(u) {
			return &SecretLeak{Key: blindLeakKey, File: ""}
		}
	}
	if a.blind { // a word it cannot read at all (`"$f"`, `"$(…)"`) could be a file
		return &SecretLeak{Key: blindLeakKey, File: ""}
	}
	// find -exec and xargs hand each file to the command as `{}`
	runner := false
	for _, w := range a.words {
		runner = runner || w == "-exec" || w == "-execdir" || w == "xargs"
	}
	if runner {
		for _, w := range a.words {
			if strings.Contains(w, "{}") {
				return &SecretLeak{Key: blindLeakKey, File: ""}
			}
		}
	}
	return pr.folderLeak(r, a)
}

// outVariants is what a word may name once an option or a curl form is peeled
// off: the word itself and the part after each `=` or `:`, each with a leading
// short option (`-d@x`, `-Fx`), `@` or `<` removed and cut at the first `;` (curl's
// `f=@.env;type=text/plain`).
func outVariants(w string) []string {
	parts := []string{w}
	for i := 0; i < len(w); i++ {
		if w[i] == '=' || w[i] == ':' {
			parts = append(parts, w[i+1:])
		}
	}
	var out []string
	for _, p := range parts {
		p, _, _ = strings.Cut(p, ";")
		p = shortOptTail(p)
		p = strings.TrimLeft(p, "@<")
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// shortOptTail strips a short option letter off the front (`-d@x` is `@x`).
func shortOptTail(p string) string {
	if len(p) >= 2 && p[0] == '-' && p[1] != '-' {
		return p[2:]
	}
	return p
}

// namedIn is the env file a word names, "" when it names none. A URL word names no
// local file.
func namedIn(w string) string {
	if strings.Contains(w, "://") {
		return ""
	}
	for _, c := range outVariants(w) {
		if isSensitive(c) {
			return c
		}
	}
	return ""
}

// blindFileRef reports a word whose known text makes what follows a file
// reference: any `=`/`:` part, short option removed, that starts with `@` or `<`.
func blindFileRef(u string) bool {
	parts := []string{u}
	for i := 0; i < len(u); i++ {
		if u[i] == '=' || u[i] == ':' {
			parts = append(parts, u[i+1:])
		}
	}
	for _, p := range parts {
		p = shortOptTail(p)
		if strings.HasPrefix(p, "@") || strings.HasPrefix(p, "<") {
			return true
		}
	}
	return false
}

// dirTools are the commands that send a whole folder: when one is on an outbound
// line, every folder the line names is searched for a .env (one level down, as
// workspaceEnvFiles does). git is not among them: it honours .gitignore, a card on
// every push would be noise, and a .env a repository committed is the limit the
// docs state.
var dirTools = map[string]bool{
	"rsync": true, "scp": true, "sftp": true, "tar": true, "zip": true, "7z": true, "7za": true, "cpio": true, "pax": true,
	"aws": true, "gcloud": true, "gsutil": true, "az": true, "azcopy": true, "rclone": true, "s3cmd": true,
	"lftp": true, "smbclient": true, "kubectl": true,
}

func (pr Protected) folderLeak(r Request, a *bashAnalysis) *SecretLeak {
	tool := false
	for _, w := range a.words {
		tool = tool || dirTools[w]
	}
	if !tool {
		return nil
	}
	base := r.Workspace
	if r.Workdir != "" {
		base = pr.workdirOf(r)
	}
	if base == "" {
		return nil
	}
	seen := map[string]bool{}
	for _, w := range a.words {
		if w == "" || strings.HasPrefix(w, "-") {
			continue
		}
		for _, c := range []string{w, afterAny(w, "="), afterAny(w, ":")} {
			if c == "" {
				continue
			}
			dir := pr.abs(c, base)
			if seen[dir] {
				continue
			}
			seen[dir] = true
			if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
				continue
			}
			if envs := workspaceEnvFiles(dir); len(envs) > 0 {
				return &SecretLeak{Key: dirLeakKey, File: filepath.Base(envs[0])}
			}
		}
	}
	return nil
}

// urlPath finds a scheme in a path: `https:/host/x` is what a URL word becomes
// when it is joined to a directory and cleaned.
var urlPath = regexp.MustCompile(`[A-Za-z][A-Za-z0-9+.-]*:/`)

// The key a file leak's card names (the card says "the value of <key> from
// <file>").
const (
	fileLeakKey  = "the file itself"
	blindLeakKey = "a word galopin cannot read"
	dirLeakKey   = "a folder that holds a secret file"
)

// outboundRe finds what sends text off the machine: a network client, a remote
// shell or copy, a package publish, and any http(s) URL or scp-style remote
// (which is also how a `git push` to a remote not yet configured is spelled).
var outboundRe = regexp.MustCompile(`(?i)(^|[\s;&|(` + "`" + `'"=<>$])(curl|wget|nc|ncat|netcat|socat|telnet|ftp|sftp|ssh|scp|rsync|http|https|xh|httpie|aria2c|rclone|gsutil|s3cmd|lftp|smbclient|mail|mailx|sendmail|mutt|croc|wormhole|fly|flyctl|vercel|netlify|heroku|glab|gh)(\s|$)` +
	`|(^|[\s;&|(` + "`" + `])(npm|pnpm|yarn|bun)\s+(\S+\s+)*publish\b` +
	`|(^|[\s;&|(` + "`" + `])(twine\s+upload|cargo\s+publish|gem\s+push|poetry\s+publish|uv\s+publish|docker\s+push|git\s+push|mvn\s+(\S+\s+)*deploy|aws|gcloud|az|kubectl|psql|flutter\s+pub\s+publish|dotnet\s+nuget\s+push)\b` +
	`|https?://|\b[\w.-]+@[\w.-]+:[\w./~-]`)

func outbound(text string) bool { return outboundRe.MatchString(text) }

type secretEntry struct {
	key, file string
	needles   []string
}

type cachedSecrets struct {
	mod     time.Time
	size    int64
	entries []secretEntry // file is filled in per call
}

var (
	secretMu    sync.Mutex
	secretCache = map[string]cachedSecrets{}
)

// secretEntries is the needles of every known secret for a workspace: the
// workspace's env files, then the credential files. Files are parsed again only
// when their mtime or size changes.
func (pr Protected) secretEntries(workspace string) []secretEntry {
	var out []secretEntry
	seen := map[string]bool{}
	budget := maxSecretFiles
	add := func(path, display string) {
		if budget <= 0 || seen[path] {
			return
		}
		seen[path] = true
		budget--
		for _, e := range fileSecrets(path) {
			e.file = display
			out = append(out, e)
		}
	}
	if workspace != "" {
		for _, p := range workspaceEnvFiles(workspace) {
			rel, err := filepath.Rel(workspace, p)
			if err != nil {
				rel = p
			}
			add(p, filepath.ToSlash(rel))
		}
	}
	for _, d := range pr.SecretDirs {
		walkSecretFiles(d, 0, func(p string) { add(p, pr.tildeForm(p)) })
	}
	return out
}

// workspaceEnvFiles are the .env* files at the workspace root and one directory
// down (a monorepo's apps), without the example, sample and template files that
// hold placeholders.
func workspaceEnvFiles(ws string) []string {
	var out []string
	scan := func(dir string) []os.DirEntry {
		ents, _ := os.ReadDir(dir)
		for _, e := range ents {
			n := e.Name()
			if ln := strings.ToLower(n); e.Type().IsRegular() && (ln == ".env" || strings.HasPrefix(ln, ".env.")) && !placeholderEnv(n) {
				out = append(out, filepath.Join(dir, n))
			}
		}
		return ents
	}
	for i, e := range scan(ws) {
		if i >= 200 {
			break
		}
		n := e.Name()
		if e.IsDir() && !strings.HasPrefix(n, ".") && n != "node_modules" && n != "vendor" && n != "dist" && n != "build" {
			scan(filepath.Join(ws, n))
		}
	}
	return out
}

func placeholderEnv(name string) bool {
	for _, s := range []string{".example", ".sample", ".template", ".dist", ".defaults"} {
		if strings.HasSuffix(strings.ToLower(name), s) {
			return true
		}
	}
	return false
}

// walkSecretFiles calls fn for a credential path: the file itself, or the
// regular files under a directory down to two levels.
func walkSecretFiles(p string, depth int, fn func(string)) {
	fi, err := os.Lstat(p)
	if err != nil {
		return
	}
	switch {
	case fi.Mode().IsRegular():
		n := fi.Name()
		if fi.Size() <= maxSecretFile && !strings.HasSuffix(n, ".pub") && n != "known_hosts" {
			fn(p)
		}
	case fi.IsDir() && depth < 2:
		ents, _ := os.ReadDir(p)
		for i, e := range ents {
			if i >= 100 {
				break
			}
			if e.Name() == "logs" || e.Name() == "node_modules" {
				continue
			}
			walkSecretFiles(filepath.Join(p, e.Name()), depth+1, fn)
		}
	}
}

func fileSecrets(path string) []secretEntry {
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > maxSecretFile {
		return nil
	}
	secretMu.Lock()
	c, ok := secretCache[path]
	secretMu.Unlock()
	if ok && c.mod.Equal(fi.ModTime()) && c.size == fi.Size() {
		return c.entries
	}
	var entries []secretEntry
	if data, err := os.ReadFile(path); err == nil && !strings.ContainsRune(string(data), 0) {
		entries = parseSecrets(string(data))
	}
	secretMu.Lock()
	if len(secretCache) > 2000 {
		secretCache = map[string]cachedSecrets{}
	}
	secretCache[path] = cachedSecrets{mod: fi.ModTime(), size: fi.Size(), entries: entries}
	secretMu.Unlock()
	return entries
}

var (
	credURL     = regexp.MustCompile(`://[^:@/\s]+:([^@/\s]+)@`)
	secretWord  = regexp.MustCompile(`(?i)key|secret|token|pass|pwd|auth|cred|private`)
	emailValue  = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$`)
	plainWords  = regexp.MustCompile(`^[a-z][a-z .:/_-]*$`)
	bareURL     = regexp.MustCompile(`^[a-z][a-z0-9+.-]*://[^@\s]*$`)
	interpolate = regexp.MustCompile(`\$\{?[A-Za-z_(]`)
)

// parseSecrets reads KEY=VALUE, KEY: VALUE, JSON "key": "value", netrc-style
// `password X` and user:password@ URLs out of a text, one needle set per value
// of at least minSecretValue characters that is plausibly a secret.
func parseSecrets(text string) []secretEntry {
	var out []secretEntry
	seen := map[string]bool{}
	put := func(key, val string) {
		val = strings.TrimSpace(val)
		if len(val) < minSecretValue || seen[val] || !plausibleSecret(key, val) {
			return
		}
		seen[val] = true
		key = strings.Trim(strings.TrimSpace(key), `"' `)
		if len(key) > 80 {
			key = key[:80]
		}
		out = append(out, secretEntry{key: key, needles: needlesFor(val)})
	}
	// A JSON document (a docker config, a kubeconfig in JSON) is read as JSON: every string
	// leaf is a value, however the file is laid out
	if t := strings.TrimSpace(text); strings.HasPrefix(t, "{") || strings.HasPrefix(t, "[") {
		var doc any
		if json.Unmarshal([]byte(t), &doc) == nil {
			walkJSON(doc, "", func(key, val string) {
				for _, g := range credURL.FindAllStringSubmatch(val, -1) {
					put("password", g[1])
				}
				put(key, val)
			})
			return out
		}
	}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") || strings.HasPrefix(line, "//") && !strings.Contains(line, "=") {
			continue
		}
		if m := credURL.FindAllStringSubmatch(line, -1); m != nil {
			for _, g := range m {
				put("password", g[1])
			}
		}
		line = strings.TrimPrefix(line, "export ")
		key, val, ok := splitKV(line)
		if ok {
			put(key, unquote(val))
			continue
		}
		// netrc: `machine h login u password p`
		f := strings.Fields(line)
		for i := 0; i+1 < len(f); i++ {
			if f[i] == "password" || f[i] == "account" {
				put(f[i], f[i+1])
			}
		}
	}
	return out
}

// walkJSON calls fn with the nearest object key and every string leaf of a decoded document.
func walkJSON(v any, key string, fn func(key, val string)) {
	switch t := v.(type) {
	case string:
		fn(key, t)
	case map[string]any:
		for k, c := range t {
			walkJSON(c, k, fn)
		}
	case []any:
		for _, c := range t {
			walkJSON(c, key, fn)
		}
	}
}

// splitKV splits at the separator that comes first, so a value that itself holds
// "=" or ": " (base64 padding) stays whole.
func splitKV(line string) (key, val string, ok bool) {
	best, bestSep := -1, ""
	for _, sep := range []string{"=", `": `, ": "} {
		if i := strings.Index(line, sep); i > 0 && (best < 0 || i < best) {
			best, bestSep = i, sep
		}
	}
	if best < 0 {
		return "", "", false
	}
	key, val = line[:best], line[best+len(bestSep):]
	if bestSep == `": ` {
		key += `"`
	}
	return key, val, true
}

func unquote(v string) string {
	v = strings.TrimSpace(v)
	v = strings.TrimSuffix(v, ",")
	if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
		return v[1 : len(v)-1]
	}
	// an unquoted value may carry a trailing comment
	if i := strings.Index(v, " #"); i > 0 {
		v = strings.TrimSpace(v[:i])
	}
	return v
}

// plausibleSecret drops the values a config file holds that are not secrets and
// would only make false hits: references to other variables, e-mail addresses,
// URLs with no credentials, absolute paths, and plain lower-case words, unless
// the key's own name says it is one.
func plausibleSecret(key, val string) bool {
	if interpolate.MatchString(val) {
		return false
	}
	if secretWord.MatchString(key) {
		return true
	}
	switch {
	case emailValue.MatchString(val), bareURL.MatchString(val), strings.HasPrefix(val, "/"), strings.HasPrefix(val, "./"), plainWords.MatchString(val):
		return false
	}
	return true
}

// needlesFor is a value and its common encodings: URL-encoded, hex, and base64
// (standard and URL-safe) at each of the three byte alignments a value can sit
// at inside a longer base64 text.
func needlesFor(v string) []string {
	set := map[string]bool{v: true}
	for _, e := range []string{url.QueryEscape(v), url.PathEscape(v)} {
		set[e] = true
		set[lowerPercent(e)] = true
	}
	set[hex.EncodeToString([]byte(v))] = true
	set[strings.ToUpper(hex.EncodeToString([]byte(v)))] = true
	for o := 0; o < 3; o++ {
		for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.URLEncoding} {
			s := enc.EncodeToString([]byte(strings.Repeat("A", o) + v))
			s = strings.TrimRight(s, "=")
			// the leading characters mix in the prefix bytes and the trailing ones the end padding
			lead := []int{0, 2, 3}[o]
			trail := []int{0, 2, 1}[(len(v)+o)%3]
			if len(s) > lead+trail+8 {
				set[s[lead:len(s)-trail]] = true
			}
		}
	}
	out := make([]string, 0, len(set))
	for n := range set {
		if len(n) >= minSecretValue {
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}

var pctHex = regexp.MustCompile(`%[0-9A-F]{2}`)

func lowerPercent(s string) string {
	return pctHex.ReplaceAllStringFunc(s, strings.ToLower)
}
