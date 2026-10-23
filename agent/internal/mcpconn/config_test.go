package mcpconn

import (
	"strings"
	"testing"
)

func lookupMap(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func TestParseClaudeFormat(t *testing.T) {
	body := `{
	  "mcpServers": {
	    "notes": {"command": "npx", "args": ["-y", "srv", "${HOME_DIR}/notes"], "env": {"LOG": "${LEVEL:-warn}"}, "cwd": "/tmp",
	              "description": "My notes", "allowedTools": ["read_file"]},
	    "crm": {"type": "http", "url": "http://127.0.0.1:9000/mcp", "headers": {"Authorization": "Bearer ${CRM_TOKEN}"}},
	    "streamy": {"type": "streamable-http", "url": "https://x.example/mcp"},
	    "old": {"type": "sse", "url": "https://x.example/sse", "disabled": true},
	    "unknown": {"type": "websocket", "url": "ws://x"},
	    "nocmd": {},
	    "urlonly": {"url": "https://x.example/mcp"},
	    "badurl": {"type": "http", "url": "ftp://x"},
	    "bad name": {"command": "x"},
	    "claude-extra": {"command": "x", "someClaudeKey": [1, 2]}
	  }
	}`
	entries, err := Parse([]byte(body), lookupMap(map[string]string{"HOME_DIR": "/home/me", "CRM_TOKEN": "s3cret"}))
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]*Entry{}
	for _, e := range entries {
		by[e.Name] = e
	}
	n := by["notes"]
	if n.Transport != TransportStdio || n.Command != "npx" || n.Args[2] != "/home/me/notes" || n.Env["LOG"] != "warn" ||
		n.Cwd != "/tmp" || *n.Description != "My notes" || len(n.AllowedTools) != 1 || n.State() != StateReady {
		t.Errorf("notes = %+v", n)
	}
	if c := by["crm"]; c.Transport != TransportHTTP || c.Headers["Authorization"] != "Bearer s3cret" || c.State() != StateReady {
		t.Errorf("crm = %+v", c)
	}
	if by["streamy"].Transport != TransportHTTP {
		t.Errorf("streamable-http is %s", by["streamy"].Transport)
	}
	if o := by["old"]; o.Transport != TransportSSE || o.State() != StateDisabled {
		t.Errorf("old = %+v", o)
	}
	for _, name := range []string{"unknown", "nocmd", "urlonly", "badurl", "bad name"} {
		if by[name].State() != StateInvalid || by[name].Invalid == "" {
			t.Errorf("%s should be invalid: %+v", name, by[name])
		}
	}
	if by["claude-extra"].State() != StateReady {
		t.Errorf("a key galopin does not know must be ignored: %+v", by["claude-extra"])
	}
	if by["notes"].AllowedTools == nil || by["crm"].AllowedTools != nil {
		t.Errorf("allowedTools: absent must be nil (every tool)")
	}
}

func TestUnsetVariableNamesTheVariableNotAValue(t *testing.T) {
	body := `{"mcpServers": {"a": {"command": "x", "env": {"K": "prefix-${API_KEY}-suffix"}, "args": ["${SET}"]}}}`
	entries, err := Parse([]byte(body), lookupMap(map[string]string{"SET": "topsecretvalue"}))
	if err != nil {
		t.Fatal(err)
	}
	e := entries[0]
	if e.State() != StateInvalid || e.Invalid != "${API_KEY} is not set" {
		t.Fatalf("invalid = %q", e.Invalid)
	}
	if strings.Contains(e.Invalid, "topsecretvalue") {
		t.Fatal("a value leaked into the reason")
	}
}

func TestEmptyButSetVariableIsSet(t *testing.T) {
	entries, _ := Parse([]byte(`{"mcpServers":{"a":{"command":"x","args":["${E}","${E:-d}"]}}}`), lookupMap(map[string]string{"E": ""}))
	if e := entries[0]; e.State() != StateReady || e.Args[0] != "" || e.Args[1] != "" {
		t.Fatalf("%+v", e)
	}
}

func TestParseRejectsGarbage(t *testing.T) {
	if _, err := Parse([]byte(`{not json`), lookupMap(nil)); err == nil {
		t.Fatal("garbage parsed")
	}
	entries, err := Parse([]byte(`{}`), lookupMap(nil))
	if err != nil || len(entries) != 0 {
		t.Fatalf("%v %v", entries, err)
	}
}

func TestSame(t *testing.T) {
	a, _ := Parse([]byte(`{"mcpServers":{"a":{"command":"x","args":["1"]}}}`), lookupMap(nil))
	b, _ := Parse([]byte(`{"mcpServers":{"a":{"command":"x","args":["1"]}}}`), lookupMap(nil))
	c, _ := Parse([]byte(`{"mcpServers":{"a":{"command":"x","args":["2"]}}}`), lookupMap(nil))
	if !a[0].Same(b[0]) || a[0].Same(c[0]) {
		t.Fatal("Same is wrong")
	}
}
