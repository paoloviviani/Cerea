package mcpconn

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
)

// Transport names the three kinds of server (PROTOCOL.md §10.1).
type Transport string

const (
	TransportStdio Transport = "stdio"
	TransportHTTP  Transport = "http"
	TransportSSE   Transport = "sse"
)

// Server states as mcp.list reports them (PROTOCOL.md §10.3).
const (
	StateReady      = "ready"
	StateDisabled   = "disabled"
	StateInvalid    = "invalid"
	StateNeedsLogin = "needs-login"
)

var nameRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)

// Entry is one server of mcp.json, with ${VAR} already expanded.
type Entry struct {
	Name         string
	Transport    Transport
	Description  *string
	Disabled     bool
	AllowedTools []string // nil: every tool; empty: none

	Command string
	Args    []string
	Env     map[string]string
	Cwd     string

	URL     string
	Headers map[string]string

	// Invalid is why the entry cannot start (never a value of a variable).
	Invalid string
}

// State is the entry's own state; needs-login is the hub's to add.
func (e *Entry) State() string {
	switch {
	case e.Invalid != "":
		return StateInvalid
	case e.Disabled:
		return StateDisabled
	}
	return StateReady
}

// Same reports whether b would start and behave as e does.
func (e *Entry) Same(b *Entry) bool {
	x, _ := json.Marshal(e)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

type rawEntry struct {
	Type         string            `json:"type"`
	Command      string            `json:"command"`
	Args         []string          `json:"args"`
	Env          map[string]string `json:"env"`
	Cwd          string            `json:"cwd"`
	URL          string            `json:"url"`
	Headers      map[string]string `json:"headers"`
	Description  *string           `json:"description"`
	Disabled     bool              `json:"disabled"`
	AllowedTools *[]string         `json:"allowedTools"`
}

// Parse reads an mcp.json body. lookup is galopin's own environment (os.LookupEnv).
// Entries come back sorted by name; one that cannot start is kept with
// Invalid set, so the chat can list it with the reason.
func Parse(body []byte, lookup func(string) (string, bool)) ([]*Entry, error) {
	var file struct {
		Servers map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(body, &file); err != nil {
		return nil, fmt.Errorf("mcp.json: %w", err)
	}
	names := make([]string, 0, len(file.Servers))
	for n := range file.Servers {
		names = append(names, n)
	}
	sort.Strings(names)
	out := make([]*Entry, 0, len(names))
	for _, name := range names {
		out = append(out, parseEntry(name, file.Servers[name], lookup))
	}
	return out, nil
}

// Load reads path; a missing file is no servers.
func Load(path string, lookup func(string) (string, bool)) ([]*Entry, error) {
	body, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return Parse(body, lookup)
}

func parseEntry(name string, raw json.RawMessage, lookup func(string) (string, bool)) *Entry {
	e := &Entry{Name: name, Transport: TransportStdio}
	var r rawEntry
	if err := json.Unmarshal(raw, &r); err != nil {
		e.Invalid = "the entry is not a valid server object"
		return e
	}
	e.Description = r.Description
	e.Disabled = r.Disabled
	if r.AllowedTools != nil {
		e.AllowedTools = append([]string{}, *r.AllowedTools...)
	}
	switch strings.ToLower(r.Type) {
	case "", "stdio":
		e.Transport = TransportStdio
	case "http", "streamable-http", "streamablehttp":
		e.Transport = TransportHTTP
	case "sse":
		e.Transport = TransportSSE
	default:
		e.Invalid = fmt.Sprintf("unknown server type %q", r.Type)
		return e
	}
	if !nameRE.MatchString(name) {
		e.Invalid = "the name must be letters, digits, - and _, starting with a letter or digit, at most 64 characters"
		return e
	}
	x := &expander{lookup: lookup}
	switch e.Transport {
	case TransportStdio:
		if r.Command == "" {
			if r.URL != "" {
				e.Invalid = `a server with a url needs "type": "http" or "sse"`
			} else {
				e.Invalid = `a stdio server needs a "command"`
			}
			return e
		}
		e.Command = x.expand(r.Command)
		for _, a := range r.Args {
			e.Args = append(e.Args, x.expand(a))
		}
		if len(r.Env) > 0 {
			e.Env = map[string]string{}
			for k, v := range r.Env {
				e.Env[k] = x.expand(v)
			}
		}
		e.Cwd = x.expand(r.Cwd)
	default:
		if r.URL == "" {
			e.Invalid = `an http or sse server needs a "url"`
			return e
		}
		e.URL = x.expand(r.URL)
		if len(r.Headers) > 0 {
			e.Headers = map[string]string{}
			for k, v := range r.Headers {
				e.Headers[k] = x.expand(v)
			}
		}
	}
	if x.missing != "" {
		e.Invalid = "${" + x.missing + "} is not set"
		return e
	}
	if e.Transport != TransportStdio && !strings.HasPrefix(e.URL, "http://") && !strings.HasPrefix(e.URL, "https://") {
		// The value is not echoed: a URL can carry a token.
		e.Invalid = "the url must start with http:// or https://"
	}
	return e
}

// expander expands ${VAR} and ${VAR:-default}; the first variable that is
// unset (and has no default) is remembered by name.
type expander struct {
	lookup  func(string) (string, bool)
	missing string
}

var varRE = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}`)

func (x *expander) expand(s string) string {
	return varRE.ReplaceAllStringFunc(s, func(m string) string {
		sub := varRE.FindStringSubmatch(m)
		if v, ok := x.lookup(sub[1]); ok {
			return v
		}
		if sub[2] != "" {
			return sub[3]
		}
		if x.missing == "" {
			x.missing = sub[1]
		}
		return ""
	})
}
