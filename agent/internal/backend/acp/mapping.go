package acp

import (
	"encoding/base64"
	"net/url"
	"strings"
	"unicode/utf8"

	"galopin/internal/backend"
)

// This file reads ACP's JSON shapes defensively (multiple candidate keys,
// tolerant of absence), the same discipline internal/backend/opencode's
// mapping.go documents: ACP's own spec has unstable corners (session/new's
// modes/models is a draft; found live, opencode 1.18.31 answers with its
// own configOptions shape instead), so a mapping written against one ACP
// agent should degrade gracefully against another rather than panic or
// silently drop everything. The initialize/session/new/session/prompt/
// session/update shapes below were verified live against opencode 1.18.31's
// `opencode acp` (see acp_it_test.go); the rest follow the published ACP
// schema as closely as a stdlib-only, dependency-free reader reasonably can.

func getStr(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s, ok := v.(string); ok {
				return s
			}
		}
	}
	return ""
}

func getBool(m map[string]any, keys ...string) bool {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if b, ok := v.(bool); ok {
				return b
			}
		}
	}
	return false
}

func getMap(m map[string]any, keys ...string) map[string]any {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if sub, ok := v.(map[string]any); ok {
				return sub
			}
		}
	}
	return nil
}

func getSlice(m map[string]any, keys ...string) []any {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s, ok := v.([]any); ok {
				return s
			}
		}
	}
	return nil
}

// present reports whether m has key with a value that is neither absent,
// null nor false — ACP's initialize result advertises sessionCapabilities
// entries as small objects ({}), not booleans (found live), so "the key
// exists with a non-false value" is what "advertised" means here.
func present(m map[string]any, key string) bool {
	v, ok := m[key]
	if !ok || v == nil {
		return false
	}
	if b, isBool := v.(bool); isBool {
		return b
	}
	return true
}

func asMaps(items []any) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		if m, ok := it.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// mapToolStatus turns ACP's tool_call/tool_call_update status into the
// normalized backend.ToolStatus (PROTOCOL.md §7: pending/running/completed
// /error).
func mapToolStatus(s string) backend.ToolStatus {
	switch s {
	case "pending":
		return backend.ToolPending
	case "in_progress":
		return backend.ToolRunning
	case "completed":
		return backend.ToolCompleted
	case "failed":
		return backend.ToolFailed
	default:
		return backend.ToolPending
	}
}

// toolCallText pulls the human-readable text out of tool_call_update's
// content array ({content:[{type:"content",content:{type:"text",text}}]},
// verified live) or, failing that, a "text"/"output" string anywhere
// reasonable in rawOutput — ACP does not pin rawOutput's shape at all (it
// is the tool's own arbitrary result), so this is best-effort by design.
func toolCallText(m map[string]any) string {
	items := asMaps(getSlice(m, "content"))
	for _, c := range items {
		inner := getMap(c, "content")
		if inner == nil {
			inner = c
		}
		if t := getStr(inner, "text"); t != "" {
			return t
		}
	}
	if raw := getMap(m, "rawOutput"); raw != nil {
		if t := getStr(raw, "output", "text", "error"); t != "" {
			return t
		}
	}
	// No text: say what the other content was (a diff's file, a linked or
	// embedded resource), so a finished edit is not an empty card.
	var lines []string
	for _, c := range items {
		switch getStr(c, "type") {
		case "diff":
			if p := getStr(c, "path"); p != "" {
				lines = append(lines, "changed "+p)
			}
		case "content":
			inner := getMap(c, "content")
			switch getStr(inner, "type") {
			case "resource_link":
				lines = append(lines, strings.TrimSpace(getStr(inner, "name")+" "+getStr(inner, "uri")))
			case "resource":
				if res := getMap(inner, "resource"); res != nil {
					if t := getStr(res, "text"); t != "" {
						return t
					}
					lines = append(lines, getStr(res, "uri"))
				}
			}
		}
	}
	return strings.Join(lines, "\n")
}

// dataURLPayload strips a "data:<mime>;base64,<payload>" URL down to its
// base64 payload, re-encoding if the URL turns out not to already be
// base64 (Attachment.URL is typed as a data: URL for P0 per PROTOCOL.md
// §6, but nothing stops a caller handing this a raw string — decoding then
// re-encoding is cheap insurance against sending the agent malformed
// content instead of failing the whole prompt).
func dataURLPayload(url string) string {
	if i := strings.Index(url, ","); i >= 0 && strings.Contains(url[:i], ";base64") {
		return url[i+1:]
	}
	return base64.StdEncoding.EncodeToString([]byte(url))
}

// promptContentBlocks turns a normalized Prompt into ACP's prompt content
// block array, gated by what the agent advertised in promptCapabilities
// (content.md: text and resource_link are baseline; image, audio and
// embedded resources are each opt-in). An attachment the agent cannot take
// is not dropped silently: a short text block tells the agent (and so the
// user, in its answer) that it was left out.
func promptContentBlocks(p backend.Prompt, caps acpAgentCapabilities) []map[string]any {
	blocks := make([]map[string]any, 0, 2+len(p.Attachments))
	// The preface says who is speaking (another session, galopin): the agent
	// reads it first, the transcript never shows it as the person's text.
	if p.Preface != "" {
		blocks = append(blocks, map[string]any{"type": "text", "text": p.Preface})
	}
	if p.Text != "" {
		blocks = append(blocks, map[string]any{"type": "text", "text": p.Text})
	}
	for _, a := range p.Attachments {
		mime := strings.ToLower(strings.TrimSpace(a.Mime))
		switch {
		case strings.HasPrefix(mime, "image/") && caps.promptImage:
			blocks = append(blocks, map[string]any{"type": "image", "mimeType": a.Mime, "data": dataURLPayload(a.URL)})
		case strings.HasPrefix(mime, "audio/") && caps.promptAudio:
			blocks = append(blocks, map[string]any{"type": "audio", "mimeType": a.Mime, "data": dataURLPayload(a.URL)})
		case caps.promptEmbedded && !strings.HasPrefix(mime, "image/") && !strings.HasPrefix(mime, "audio/"):
			blocks = append(blocks, embeddedResource(a))
		default:
			name := a.Filename
			if name == "" {
				name = a.Mime
			}
			blocks = append(blocks, map[string]any{"type": "text", "text": "[attachment " + name + " not sent: this agent does not accept that kind of content]"})
		}
	}
	return blocks
}

// embeddedResource is an attachment as an embedded resource block (the
// preferred way to hand an agent context). Text types travel as text, the
// rest as a base64 blob. The uri names the attachment only: it is not a path
// on any machine.
func embeddedResource(a backend.Attachment) map[string]any {
	name := a.Filename
	if name == "" {
		name = "attachment"
	}
	res := map[string]any{"uri": "attachment:///" + url.PathEscape(name)}
	if a.Mime != "" {
		res["mimeType"] = a.Mime
	}
	payload := dataURLPayload(a.URL)
	if raw, err := base64.StdEncoding.DecodeString(payload); err == nil && isTextMime(a.Mime) && utf8.Valid(raw) {
		res["text"] = string(raw)
	} else {
		res["blob"] = payload
	}
	return map[string]any{"type": "resource", "resource": res}
}

func isTextMime(m string) bool {
	m = strings.ToLower(m)
	return strings.HasPrefix(m, "text/") || strings.Contains(m, "json") || strings.Contains(m, "xml") ||
		strings.Contains(m, "yaml") || strings.Contains(m, "javascript") || strings.Contains(m, "markdown")
}

// sessionConfig is what session/new, /load, /resume and /set_config_option
// say about a session's selectors. The stable form is configOptions (a
// "select" option per selector, found by category, falling back to the id
// "mode"/"model"); the deprecated modes/models objects are read when no
// config option names that selector. modeConfigID/modelConfigID are the
// option ids to set with session/set_config_option ("" when the selector only
// exists in the legacy form and session/set_mode|set_model applies).
type sessionConfig struct {
	modes                       []backend.Mode
	models                      []backend.Model
	modeID, modelID             string
	modeConfigID, modelConfigID string
}

func parseSessionConfig(m map[string]any) sessionConfig {
	var c sessionConfig
	if modesObj := getMap(m, "modes"); modesObj != nil {
		c.modeID = getStr(modesObj, "currentModeId")
		for _, mm := range asMaps(getSlice(modesObj, "availableModes")) {
			c.modes = append(c.modes, backend.Mode{ID: getStr(mm, "id"), Label: getStr(mm, "name"), Description: getStr(mm, "description")})
		}
	}
	if modelsObj := getMap(m, "models"); modelsObj != nil {
		c.modelID = getStr(modelsObj, "currentModelId")
		for _, mm := range asMaps(getSlice(modelsObj, "availableModels")) {
			c.models = append(c.models, backend.Model{ID: getStr(mm, "modelId", "id"), Label: getStr(mm, "name")})
		}
	}
	var haveMode, haveModel bool
	for _, opt := range asMaps(getSlice(m, "configOptions")) {
		if t := getStr(opt, "type"); t != "" && t != "select" {
			continue // boolean options are not offered: the client did not advertise them
		}
		id, cat := getStr(opt, "id"), getStr(opt, "category")
		var values []map[string]any
		for _, o := range asMaps(getSlice(opt, "options")) {
			if grouped := asMaps(getSlice(o, "options")); len(grouped) > 0 {
				values = append(values, grouped...)
			} else {
				values = append(values, o)
			}
		}
		switch {
		case (cat == "mode" || (cat == "" && id == "mode")) && !haveMode:
			haveMode = true
			c.modeConfigID, c.modeID = id, getStr(opt, "currentValue")
			c.modes = nil
			for _, o := range values {
				c.modes = append(c.modes, backend.Mode{ID: getStr(o, "value"), Label: getStr(o, "name"), Description: getStr(o, "description")})
			}
		case (cat == "model" || (cat == "" && id == "model")) && !haveModel:
			haveModel = true
			c.modelConfigID, c.modelID = id, getStr(opt, "currentValue")
			c.models = nil
			for _, o := range values {
				c.models = append(c.models, backend.Model{ID: getStr(o, "value"), Label: getStr(o, "name")})
			}
		}
	}
	return c
}
