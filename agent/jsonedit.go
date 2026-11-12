package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// A minimal-edit writer for the "mcpServers" object of mcp.json. The file is the user's: their
// key order, indentation, other servers and unknown keys stay byte for byte. Only the one
// member galopin manages is inserted, replaced or removed, in place. A file that is a symlink is
// written through to its target, so the link stays a link.

type jsonMember struct {
	key                        string
	keyStart, valStart, valEnd int
}

func skipWS(b []byte, i int) int {
	for i < len(b) && (b[i] == ' ' || b[i] == '\t' || b[i] == '\n' || b[i] == '\r') {
		i++
	}
	return i
}

// skipString returns the index after the string literal that starts at b[i] == '"'.
func skipString(b []byte, i int) (int, error) {
	for j := i + 1; j < len(b); j++ {
		switch b[j] {
		case '\\':
			j++
		case '"':
			return j + 1, nil
		}
	}
	return 0, errors.New("unterminated string")
}

// skipValue returns the index after the JSON value that starts at b[i].
func skipValue(b []byte, i int) (int, error) {
	if i >= len(b) {
		return 0, errors.New("unexpected end")
	}
	switch b[i] {
	case '"':
		return skipString(b, i)
	case '{', '[':
		depth := 0
		for j := i; j < len(b); j++ {
			switch b[j] {
			case '"':
				end, err := skipString(b, j)
				if err != nil {
					return 0, err
				}
				j = end - 1
			case '{', '[':
				depth++
			case '}', ']':
				depth--
				if depth == 0 {
					return j + 1, nil
				}
			}
		}
		return 0, errors.New("unterminated value")
	default:
		j := i
		for j < len(b) && !strings.ContainsRune(",}] \t\r\n", rune(b[j])) {
			j++
		}
		return j, nil
	}
}

// objectMembers lists the members of the object whose '{' is at b[open] and the index of its '}'.
func objectMembers(b []byte, open int) ([]jsonMember, int, error) {
	if open >= len(b) || b[open] != '{' {
		return nil, 0, errors.New("not an object")
	}
	var members []jsonMember
	i := skipWS(b, open+1)
	for {
		if i >= len(b) {
			return nil, 0, errors.New("unterminated object")
		}
		if b[i] == '}' {
			return members, i, nil
		}
		if b[i] != '"' {
			return nil, 0, fmt.Errorf("unexpected %q", b[i])
		}
		keyEnd, err := skipString(b, i)
		if err != nil {
			return nil, 0, err
		}
		var key string
		if err := json.Unmarshal(b[i:keyEnd], &key); err != nil {
			return nil, 0, err
		}
		j := skipWS(b, keyEnd)
		if j >= len(b) || b[j] != ':' {
			return nil, 0, errors.New("expected ':'")
		}
		valStart := skipWS(b, j+1)
		valEnd, err := skipValue(b, valStart)
		if err != nil {
			return nil, 0, err
		}
		members = append(members, jsonMember{key, i, valStart, valEnd})
		i = skipWS(b, valEnd)
		if i < len(b) && b[i] == ',' {
			i = skipWS(b, i+1)
		}
	}
}

func find(members []jsonMember, key string) *jsonMember {
	for i := range members {
		if members[i].key == key {
			return &members[i]
		}
	}
	return nil
}

// lineIndent is the whitespace that starts the line holding b[at].
func lineIndent(b []byte, at int) string {
	start := bytes.LastIndexByte(b[:at], '\n') + 1
	end := start
	for end < at && (b[end] == ' ' || b[end] == '\t') {
		end++
	}
	return string(b[start:end])
}

// indentUnit is one level of the file's indentation, judged from a member and its parent.
func indentUnit(child, parent string) string {
	if strings.HasPrefix(child, parent) && len(child) > len(parent) {
		return child[len(parent):]
	}
	return "\t"
}

func splice(b []byte, from, to int, with string) []byte {
	out := make([]byte, 0, len(b)-(to-from)+len(with))
	out = append(out, b[:from]...)
	out = append(out, with...)
	return append(out, b[to:]...)
}

// insertMember adds `"key": value` as the last member of the object at open.
func insertMember(b []byte, open int, key string, value []byte, parentIndent, unit string) ([]byte, error) {
	members, closeAt, err := objectMembers(b, open)
	if err != nil {
		return nil, err
	}
	keyJSON, _ := json.Marshal(key)
	childIndent := parentIndent + unit
	if len(members) > 0 {
		childIndent = lineIndent(b, members[0].keyStart)
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, value, childIndent, unit); err != nil {
		return nil, err
	}
	member := string(keyJSON) + ": " + pretty.String()
	if len(members) == 0 {
		return splice(b, open+1, closeAt, "\n"+childIndent+member+"\n"+parentIndent), nil
	}
	last := members[len(members)-1]
	return splice(b, last.valEnd, last.valEnd, ",\n"+childIndent+member), nil
}

// editMcpServers inserts or replaces the server `name` (value non-nil) or removes it (value nil)
// in the mcp.json at path, leaving everything else as it was. It reports whether anything changed.
func editMcpServers(path, name string, value []byte) (bool, error) {
	target := path
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		target = resolved
	}
	body, err := os.ReadFile(target)
	if err != nil && !os.IsNotExist(err) {
		return false, err
	}
	perm := os.FileMode(0o600)
	if st, err := os.Stat(target); err == nil {
		perm = st.Mode().Perm()
	}
	out, changed, err := editServersText(body, name, value)
	if err != nil {
		return false, fmt.Errorf("%s: %w, so it was left alone", path, err)
	}
	if !changed {
		return false, nil
	}
	if !json.Valid(out) {
		return false, fmt.Errorf("%s: the edit would not be valid JSON, so it was left alone", path)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return false, err
	}
	return true, writeFileAtomic(target, out, perm)
}

func editServersText(body []byte, name string, value []byte) ([]byte, bool, error) {
	keyJSON, _ := json.Marshal(name)
	if len(bytes.TrimSpace(body)) == 0 {
		if value == nil {
			return nil, false, nil
		}
		var pretty bytes.Buffer
		if err := json.Indent(&pretty, value, "\t\t", "\t"); err != nil {
			return nil, false, err
		}
		return []byte("{\n\t\"mcpServers\": {\n\t\t" + string(keyJSON) + ": " + pretty.String() + "\n\t}\n}\n"), true, nil
	}
	top := skipWS(body, 0)
	if bytes.HasPrefix(body[top:], []byte("\xef\xbb\xbf")) {
		top = skipWS(body, top+3)
	}
	topMembers, _, err := objectMembers(body, top)
	if err != nil {
		return nil, false, fmt.Errorf("it is not a JSON object (%v)", err)
	}
	topIndent := lineIndent(body, top)
	servers := find(topMembers, "mcpServers")
	if servers == nil {
		if value == nil {
			return nil, false, nil
		}
		unit := "\t"
		if len(topMembers) > 0 {
			unit = indentUnit(lineIndent(body, topMembers[0].keyStart), topIndent)
		}
		empty := []byte("{}")
		out, err := insertMember(body, top, "mcpServers", empty, topIndent, unit)
		if err != nil {
			return nil, false, err
		}
		again := skipWS(out, 0)
		ms, _, _ := objectMembers(out, again)
		s := find(ms, "mcpServers")
		out, err = insertMember(out, s.valStart, name, value, lineIndent(out, s.keyStart), unit)
		return out, err == nil, err
	}
	if body[servers.valStart] != '{' {
		return nil, false, errors.New("mcpServers is not an object")
	}
	serverMembers, _, err := objectMembers(body, servers.valStart)
	if err != nil {
		return nil, false, err
	}
	parent := lineIndent(body, servers.keyStart)
	unit := "\t"
	if len(serverMembers) > 0 {
		unit = indentUnit(lineIndent(body, serverMembers[0].keyStart), parent)
	} else if len(topMembers) > 0 {
		unit = indentUnit(lineIndent(body, topMembers[0].keyStart), topIndent)
	}
	existing := find(serverMembers, name)
	switch {
	case value == nil && existing == nil:
		return nil, false, nil
	case value == nil:
		idx := 0
		for i := range serverMembers {
			if serverMembers[i].keyStart == existing.keyStart {
				idx = i
			}
		}
		switch {
		case idx+1 < len(serverMembers):
			return splice(body, existing.keyStart, serverMembers[idx+1].keyStart, ""), true, nil
		case idx > 0:
			return splice(body, serverMembers[idx-1].valEnd, existing.valEnd, ""), true, nil
		default:
			return splice(body, existing.keyStart, existing.valEnd, ""), true, nil
		}
	case existing != nil:
		var pretty bytes.Buffer
		if err := json.Indent(&pretty, value, lineIndent(body, existing.keyStart), unit); err != nil {
			return nil, false, err
		}
		if bytes.Equal(body[existing.valStart:existing.valEnd], pretty.Bytes()) {
			return nil, false, nil
		}
		return splice(body, existing.valStart, existing.valEnd, pretty.String()), true, nil
	default:
		out, err := insertMember(body, servers.valStart, name, value, parent, unit)
		return out, err == nil, err
	}
}
