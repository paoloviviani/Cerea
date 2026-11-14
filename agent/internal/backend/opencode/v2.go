package opencode

// opencode 2.x's server API (`opencode serve`, /api/...) speaks a different
// vocabulary from 1.x: an event-sourced stream (session.step.*, session.text.*,
// session.tool.*), messages whose assistant turns carry a `content` array, a
// `permissions` rule array with `shell`/`subagent` actions, forms for
// questions. The rest of this package (and every layer above it) was written
// against the 1.x shapes, so this file is the one place that knows the 2.x
// ones: it turns 2.x events and messages into the 1.x-shaped maps the mapping
// layer reads (mapping.go, events.go), and 2.x rules into the 1.x key names
// internal/decide and internal/permrules speak. Verified live against 2.3.0
// (agent/packaging/opencode-version).

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"sync"

	"galopin/internal/permrules"
)

// v1Name turns a 2.x tool or permission action name into the 1.x name the
// rest of galopin keys on (decide classes, the panel's tool names). 2.x renamed
// bash to shell and task to subagent; write and patch fold into edit as
// permission actions (the tools themselves keep their names).
func v1Name(v2 string) string {
	switch v2 {
	case "shell":
		return "bash"
	case "subagent":
		return "task"
	}
	return v2
}

// v2Action is v1Name's inverse, for rules written to opencode.
func v2Action(v1 string) string {
	switch v1 {
	case "bash":
		return "shell"
	case "task":
		return "subagent"
	}
	return v1
}

// locParam is the query parameter that selects a project directory
// (`location[directory]`; session-scoped routes derive it from the session).
func locParam(dir string) string {
	if dir == "" {
		return ""
	}
	return "location[directory]=" + url.QueryEscape(dir)
}

// withLoc appends the location parameter to a path that may already carry a
// query string.
func withLoc(path, dir string) string {
	p := locParam(dir)
	if p == "" {
		return path
	}
	if strings.Contains(path, "?") {
		return path + "&" + p
	}
	return path + "?" + p
}

// partKey is the part id galopin gives a text or reasoning part: 2.x numbers
// them by their index in the assistant message's content array.
func partKey(messageID string, ordinal int) string {
	return fmt.Sprintf("%s:%d", messageID, ordinal)
}

// toolPartKey is the part id of a tool call: 2.x names a call by the
// provider's call id, which a provider may reuse across turns, so the message
// id scopes it.
func toolPartKey(messageID, callID string) string { return messageID + ":" + callID }

// errorObject turns a 2.x structured error ({type, message, status}) into the
// 1.x error object the mapping layer reads ({name, data:{message,statusCode}}).
// An aborted step is how a Stop is recorded; it keeps the 1.x abort name.
func errorObject(e map[string]any) map[string]any {
	if e == nil {
		return nil
	}
	typ := getStr(e, "type")
	if typ == "aborted" {
		return map[string]any{"name": "MessageAbortedError", "data": map[string]any{"message": getStr(e, "message")}}
	}
	data := map[string]any{"message": getStr(e, "message")}
	if s := getFloat(e, "status"); s > 0 {
		data["statusCode"] = s
	}
	name := typ
	if name == "" {
		name = "Error"
	}
	return map[string]any{"name": name, "data": data}
}

// contentText joins a tool result's text content in order.
func contentText(content []any) string {
	var parts []string
	for _, c := range asMaps(content) {
		if getStr(c, "type") == "text" {
			parts = append(parts, getStr(c, "text"))
		}
	}
	return strings.Join(parts, "\n")
}

// contentFiles are a tool result's file content as 1.x attachments
// (FilePart-shaped: mime, filename, url).
func contentFiles(content []any) []any {
	var out []any
	for _, c := range asMaps(content) {
		if getStr(c, "type") != "file" {
			continue
		}
		out = append(out, map[string]any{
			"type": "file", "mime": getStr(c, "mime"), "filename": getStr(c, "name"), "url": getStr(c, "uri"),
		})
	}
	return out
}

// toolState builds a 1.x tool state from a 2.x one.
func toolState(st map[string]any, created, ran, completed float64) map[string]any {
	out := map[string]any{}
	switch getStr(st, "status") {
	case "streaming":
		out["status"] = "pending"
		out["input"] = map[string]any{}
	case "running":
		out["status"] = "running"
	case "completed":
		out["status"] = "completed"
	case "error":
		out["status"] = "error"
	default:
		out["status"] = getStr(st, "status")
	}
	if in := getMap(st, "input"); in != nil {
		out["input"] = in
	} else if _, ok := out["input"]; !ok {
		out["input"] = map[string]any{}
	}
	if md := getMap(st, "metadata"); md != nil {
		out["metadata"] = md
	}
	content := getSlice(st, "content")
	if len(content) > 0 {
		out["output"] = contentText(content)
		if files := contentFiles(content); len(files) > 0 {
			out["attachments"] = files
		}
	}
	if e := getMap(st, "error"); e != nil {
		out["error"] = map[string]any{"message": getStr(e, "message")}
		if out["output"] == nil {
			out["output"] = ""
		}
	}
	t := map[string]any{"start": ran}
	if completed > 0 {
		t["end"] = completed
	}
	_ = created
	out["time"] = t
	return out
}

// dataURL renders an inline file attachment as a data: URL, the shape 1.x
// reported for prompt files.
func fileDataURL(f map[string]any) string {
	src := getMap(f, "source")
	if src != nil && getStr(src, "type") == "uri" {
		return getStr(src, "uri")
	}
	data := getStr(f, "data")
	if data == "" {
		return getStr(f, "uri")
	}
	return "data:" + getStr(f, "mime") + ";base64," + data
}

// userParts builds the 1.x parts of a user message: its text, then its files.
func userParts(id, sessionID string, text string, files []any, synthetic []string) []any {
	var parts []any
	for i, s := range synthetic {
		parts = append(parts, map[string]any{
			"id": fmt.Sprintf("%s:syn%d", id, i), "messageID": id, "sessionID": sessionID,
			"type": "text", "text": s, "synthetic": true,
		})
	}
	if text != "" || len(files) == 0 {
		parts = append(parts, map[string]any{
			"id": id + ":text", "messageID": id, "sessionID": sessionID, "type": "text", "text": text,
		})
	}
	for i, f := range asMaps(files) {
		parts = append(parts, map[string]any{
			"id": fmt.Sprintf("%s:file%d", id, i), "messageID": id, "sessionID": sessionID, "type": "file",
			"mime": getStr(f, "mime"), "filename": getStr(f, "name"), "url": fileDataURL(f),
		})
	}
	return parts
}

// assistantInfo is the 1.x message info of a 2.x assistant message.
func assistantInfo(sessionID string, m map[string]any) map[string]any {
	t := getMap(m, "time")
	model := getMap(m, "model")
	info := map[string]any{
		"id": getStr(m, "id"), "role": "assistant", "sessionID": sessionID,
		"modelID": getStr(model, "id"), "providerID": getStr(model, "providerID"),
		"agent": getStr(m, "agent"), "mode": getStr(m, "agent"),
		"time": map[string]any{"created": getFloat(t, "created")},
	}
	if c := getFloat(t, "completed"); c > 0 {
		info["time"].(map[string]any)["completed"] = c
	}
	if tok := getMap(m, "tokens"); tok != nil {
		info["tokens"] = tok
		info["cost"] = getFloat(m, "cost")
	}
	if e := errorObject(getMap(m, "error")); e != nil {
		info["error"] = e
	}
	return info
}

// assistantParts is the 1.x parts of a 2.x assistant message's content.
func assistantParts(sessionID string, m map[string]any) []any {
	id := getStr(m, "id")
	var parts []any
	for i, c := range asMaps(getSlice(m, "content")) {
		switch getStr(c, "type") {
		case "text", "reasoning":
			parts = append(parts, map[string]any{
				"id": partKey(id, i), "messageID": id, "sessionID": sessionID,
				"type": getStr(c, "type"), "text": getStr(c, "text"),
			})
		case "tool":
			t := getMap(c, "time")
			parts = append(parts, map[string]any{
				"id": toolPartKey(id, getStr(c, "id")), "messageID": id, "sessionID": sessionID,
				"type": "tool", "callID": getStr(c, "id"), "tool": v1Name(getStr(c, "name")),
				"state": toolState(getMap(c, "state"), getFloat(t, "created"), getFloat(t, "ran"), getFloat(t, "completed")),
			})
		}
	}
	return parts
}

// v1Entry converts one 2.x message into the 1.x {info, parts} entry. ok is
// false for the message kinds 1.x had no counterpart for (agent and model
// switches, location moves, idle markers).
func v1Entry(sessionID string, m map[string]any) (entry map[string]any, ok bool) {
	id := getStr(m, "id")
	t := getMap(m, "time")
	switch getStr(m, "type") {
	case "user":
		info := map[string]any{"id": id, "role": "user", "sessionID": sessionID,
			"time": map[string]any{"created": getFloat(t, "created")}}
		return map[string]any{"info": info, "parts": userParts(id, sessionID, getStr(m, "text"), getSlice(m, "files"), nil)}, true
	case "synthetic", "system":
		info := map[string]any{"id": id, "role": "user", "sessionID": sessionID,
			"time": map[string]any{"created": getFloat(t, "created")}}
		return map[string]any{"info": info, "parts": []any{map[string]any{
			"id": id + ":text", "messageID": id, "sessionID": sessionID, "type": "text",
			"text": getStr(m, "text"), "synthetic": true,
		}}}, true
	case "assistant":
		return map[string]any{"info": assistantInfo(sessionID, m), "parts": assistantParts(sessionID, m)}, true
	case "compaction":
		info := map[string]any{"id": id, "role": "user", "sessionID": sessionID,
			"time": map[string]any{"created": getFloat(t, "created")}}
		return map[string]any{"info": info, "parts": []any{map[string]any{
			"id": id + ":compaction", "messageID": id, "sessionID": sessionID, "type": "compaction",
			"auto": getStr(m, "reason") == "auto",
		}}}, true
	}
	return nil, false
}

// v1Entries converts a page of 2.x messages (any order) into 1.x entries in
// the order given. A synthetic message directly before a user message (the
// preface galopin sends ahead of a prompt) folds into it as a synthetic part,
// so the transcript has one user message per prompt as it did on 1.x; pass the
// messages oldest first for that to apply.
func v1Entries(sessionID string, msgs []any, isPreface func(string) bool) []map[string]any {
	var out []map[string]any
	var pendingSyn []string
	for _, m := range asMaps(msgs) {
		if getStr(m, "type") == "synthetic" && isPreface != nil && isPreface(getStr(m, "id")) {
			pendingSyn = append(pendingSyn, getStr(m, "text"))
			continue
		}
		e, ok := v1Entry(sessionID, m)
		if !ok {
			continue
		}
		if len(pendingSyn) > 0 {
			if getStr(m, "type") == "user" {
				id := getStr(m, "id")
				e["parts"] = userParts(id, sessionID, getStr(m, "text"), getSlice(m, "files"), pendingSyn)
			} else {
				// no user message to join: show them as their own message
				for _, s := range pendingSyn {
					out = append(out, syntheticEntry(sessionID, "syn:"+fmt.Sprint(len(out)), s))
				}
			}
			pendingSyn = nil
		}
		out = append(out, e)
	}
	for _, s := range pendingSyn {
		out = append(out, syntheticEntry(sessionID, "syn:"+fmt.Sprint(len(out)), s))
	}
	return out
}

func syntheticEntry(sessionID, id, text string) map[string]any {
	return map[string]any{
		"info":  map[string]any{"id": id, "role": "user", "sessionID": sessionID, "time": map[string]any{"created": float64(0)}},
		"parts": []any{map[string]any{"id": id + ":text", "messageID": id, "sessionID": sessionID, "type": "text", "text": text, "synthetic": true}},
	}
}

// sessionInfo is the 1.x session info of a 2.x session object.
func sessionInfoV1(m map[string]any) map[string]any {
	info := map[string]any{
		"id": getStr(m, "id"), "title": getStr(m, "title"), "parentID": getStr(m, "parentID"),
		"agent": getStr(m, "agent"),
	}
	if t := getMap(m, "time"); t != nil {
		info["time"] = map[string]any{"created": getFloat(t, "created"), "updated": getFloat(t, "updated")}
	}
	if loc := getMap(m, "location"); loc != nil {
		info["directory"] = getStr(loc, "directory")
	}
	if rv := getMap(m, "revert"); rv != nil {
		info["revert"] = map[string]any{"messageID": getStr(rv, "messageID")}
	}
	return info
}

// rulesFromV2 turns a 2.x rule array into permrules, with 1.x key names.
func rulesFromV2(raw []any) []permrules.Rule {
	out := make([]permrules.Rule, 0, len(raw))
	for _, r := range asMaps(raw) {
		out = append(out, permrules.Rule{
			Permission: v1Name(getStr(r, "action")),
			Pattern:    getStr(r, "resource"),
			Action:     permrules.Action(getStr(r, "effect")),
		})
	}
	return out
}

// rulesToV2 is the inverse: permrules to the JSON array opencode takes.
func rulesToV2(rules []permrules.Rule) []map[string]string {
	out := make([]map[string]string, 0, len(rules))
	for _, r := range rules {
		out = append(out, map[string]string{
			"action": v2Action(r.Permission), "resource": r.Pattern, "effect": string(r.Action),
		})
	}
	return out
}

// v1Permission is permission.asked's payload in the 1.x shape.
func v1Permission(d map[string]any) map[string]any {
	out := map[string]any{
		"id": getStr(d, "id"), "sessionID": getStr(d, "sessionID"),
		"permission": v1Name(getStr(d, "action")),
		"patterns":   getSlice(d, "resources"),
		"always":     getSlice(d, "save"),
	}
	if md := getMap(d, "metadata"); md != nil {
		out["metadata"] = md
	}
	if src := getMap(d, "source"); src != nil {
		out["tool"] = map[string]any{"messageID": getStr(src, "messageID"), "callID": getStr(src, "id")}
	}
	return out
}

// v1Question turns a question form (metadata.kind == "question", fields q0,
// q1, …) into the 1.x question.asked shape. ok is false for any other form.
func v1Question(form map[string]any) (map[string]any, bool) {
	md := getMap(form, "metadata")
	if getStr(md, "kind") != "question" {
		return nil, false
	}
	var qs []any
	for _, f := range asMaps(getSlice(form, "fields")) {
		var opts []any
		for _, o := range asMaps(getSlice(f, "options")) {
			opts = append(opts, map[string]any{"label": getStr(o, "label"), "description": getStr(o, "description")})
		}
		qs = append(qs, map[string]any{
			"question": getStr(f, "description"), "header": getStr(f, "title"),
			"options": opts, "multiple": getStr(f, "type") == "multiselect",
		})
	}
	out := map[string]any{"id": getStr(form, "id"), "sessionID": getStr(form, "sessionID"), "questions": qs}
	if tool := getMap(md, "tool"); tool != nil {
		out["tool"] = map[string]any{"messageID": getStr(tool, "messageID"), "callID": getStr(tool, "id")}
	}
	return out, true
}

// formAnswer maps 1.x answers (one list of labels per question) onto the form
// fields: a single-select question takes its first label, a multi-select one
// the list.
func formAnswer(form map[string]any, answers [][]string) map[string]any {
	out := map[string]any{}
	for i, f := range asMaps(getSlice(form, "fields")) {
		var a []string
		if i < len(answers) {
			a = answers[i]
		}
		key := getStr(f, "key")
		if getStr(f, "type") == "multiselect" {
			if a == nil {
				a = []string{}
			}
			out[key] = a
		} else if len(a) > 0 {
			out[key] = a[0]
		} else {
			out[key] = ""
		}
	}
	return out
}

// answersFromForm is formAnswer's inverse for form.replied.
func answersFromForm(answer map[string]any) [][]string {
	var out [][]string
	for i := 0; ; i++ {
		v, ok := answer[fmt.Sprintf("q%d", i)]
		if !ok {
			return out
		}
		switch t := v.(type) {
		case string:
			out = append(out, []string{t})
		case []any:
			out = append(out, asStrings(t))
		default:
			out = append(out, nil)
		}
	}
}

// toBase64 is a helper for tests.
func toBase64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

// asmState is the per-process state the event adapter keeps: what a 2.x event
// leaves out and the 1.x one it becomes needs.
type asmState struct {
	mu sync.Mutex
	// inbox: user prompts enqueued but not yet delivered, by message id.
	inbox map[string]inboxItem
	// synthetic: preface texts waiting for the next user message, by session.
	synthetic map[string][]string
	// tools: the 1.x tool name of each in-flight call, keyed message:call.
	tools map[string]string
	// inputs: the arguments of each call (a permission ask for a shell call
	// carries only its split subcommands; the whole command line is here).
	inputs map[string]map[string]any
	// dirs: each session's directory, learned from events that carry one.
	dirs map[string]string
	// isPreface says whether a synthetic message is one galopin sent as the
	// preface of a prompt (recorded by id before it is sent).
	isPreface func(id string) bool
	// seen: directories sessions live in (known dirs).
	seen map[string]bool
	// started: assistant messages announced, with their info.
	started map[string]map[string]any
}

type inboxItem struct {
	sessionID string
	text      string
	files     []any
	// synthetic marks a message opencode (or a plugin) injected rather than a
	// person typed: a subagent's report to its parent.
	synthetic bool
}

func newAsmState() *asmState {
	return &asmState{
		inbox: map[string]inboxItem{}, synthetic: map[string][]string{}, tools: map[string]string{}, inputs: map[string]map[string]any{},
		dirs: map[string]string{}, started: map[string]map[string]any{},
	}
}

// frame is one 1.x-shaped event the adapter emits.
type frame struct {
	typ   string
	props map[string]any
}

func partUpdated(sessionID string, part map[string]any) frame {
	part["sessionID"] = sessionID
	return frame{"message.part.updated", map[string]any{"sessionID": sessionID, "part": part}}
}

// adapt turns one 2.x event into 1.x frames. created is the event's timestamp
// (ms); data its payload.
func (st *asmState) adapt(typ string, created float64, d map[string]any) []frame {
	sid := getStr(d, "sessionID")
	switch typ {
	case "session.created":
		info := map[string]any{
			"id": sid, "title": getStr(d, "title"), "parentID": getStr(d, "parentID"), "agent": getStr(d, "agent"),
			"time": map[string]any{"created": created, "updated": created},
		}
		if loc := getMap(d, "location"); loc != nil {
			info["directory"] = getStr(loc, "directory")
		}
		return []frame{{"session.created", map[string]any{"info": info}}}

	case "session.inbox.enqueued":
		item := getMap(d, "item")
		if getStr(item, "type") == "user" {
			p := getMap(item, "payload")
			st.mu.Lock()
			st.inbox[getStr(d, "inboxID")] = inboxItem{sessionID: sid, text: getStr(p, "text"), files: getSlice(p, "files")}
			st.mu.Unlock()
		} else if getStr(item, "type") == "synthetic" {
			p := getMap(item, "payload")
			st.mu.Lock()
			if st.isPreface != nil && st.isPreface(getStr(d, "inboxID")) {
				st.synthetic[sid] = append(st.synthetic[sid], getStr(p, "text"))
				st.inbox[getStr(d, "inboxID")] = inboxItem{sessionID: sid, text: "\x00preface"}
			} else {
				st.inbox[getStr(d, "inboxID")] = inboxItem{sessionID: sid, text: getStr(p, "text"), synthetic: true}
			}
			st.mu.Unlock()
		}
		return nil

	case "session.inbox.delivered":
		id := getStr(d, "inboxID")
		st.mu.Lock()
		it, ok := st.inbox[id]
		delete(st.inbox, id)
		var syn []string
		if ok && it.text != "\x00preface" {
			syn = st.synthetic[sid]
			delete(st.synthetic, sid)
		}
		st.mu.Unlock()
		if !ok || it.text == "\x00preface" {
			return nil
		}
		info := map[string]any{"id": id, "role": "user", "sessionID": sid, "time": map[string]any{"created": created}}
		out := []frame{{"message.updated", map[string]any{"sessionID": sid, "info": info}}}
		if it.synthetic {
			// opencode's own message (a subagent's report): one synthetic text part
			out = append(out, partUpdated(sid, map[string]any{
				"id": id + ":text", "messageID": id, "type": "text", "text": it.text, "synthetic": true,
			}))
			return out
		}
		for _, p := range asMaps(userParts(id, sid, it.text, it.files, syn)) {
			out = append(out, partUpdated(sid, p))
		}
		return out

	case "session.execution.started":
		return []frame{{"session.status", map[string]any{"sessionID": sid, "status": map[string]any{"type": "busy"}}}}

	case "session.execution.succeeded", "session.execution.interrupted":
		return []frame{{"session.idle", map[string]any{"sessionID": sid}}}

	case "session.execution.failed":
		return []frame{
			{"session.error", map[string]any{"sessionID": sid, "error": errorObject(getMap(d, "error"))}},
			{"session.idle", map[string]any{"sessionID": sid}},
		}

	case "session.retry.scheduled":
		e := getMap(d, "error")
		return []frame{{"session.status", map[string]any{"sessionID": sid, "status": map[string]any{
			"type": "retry", "attempt": getFloat(d, "attempt"), "message": getStr(e, "message"), "next": getFloat(d, "at"),
		}}}}

	case "session.step.started":
		mid := getStr(d, "assistantMessageID")
		model := getMap(d, "model")
		info := map[string]any{
			"id": mid, "role": "assistant", "sessionID": sid,
			"modelID": getStr(model, "id"), "providerID": getStr(model, "providerID"),
			"agent": getStr(d, "agent"), "mode": getStr(d, "agent"),
			"time": map[string]any{"created": getFloat(d, "started")},
		}
		st.mu.Lock()
		st.started[mid] = info
		st.mu.Unlock()
		return []frame{{"message.updated", map[string]any{"sessionID": sid, "info": info}}}

	case "session.step.ended", "session.step.failed":
		mid := getStr(d, "assistantMessageID")
		st.mu.Lock()
		base := st.started[mid]
		delete(st.started, mid)
		st.mu.Unlock()
		info := map[string]any{}
		for k, v := range base {
			info[k] = v
		}
		if len(info) == 0 {
			info = map[string]any{"id": mid, "role": "assistant", "sessionID": sid, "time": map[string]any{}}
		}
		tm := map[string]any{}
		if bt, ok := info["time"].(map[string]any); ok {
			for k, v := range bt {
				tm[k] = v
			}
		}
		tm["completed"] = created
		info["time"] = tm
		if tok := getMap(d, "tokens"); tok != nil {
			info["tokens"] = tok
			info["cost"] = getFloat(d, "cost")
		}
		if e := errorObject(getMap(d, "error")); e != nil && typ == "session.step.failed" {
			info["error"] = e
		}
		return []frame{{"message.updated", map[string]any{"sessionID": sid, "info": info}}}

	case "session.text.started", "session.reasoning.started":
		mid := getStr(d, "assistantMessageID")
		kind := "text"
		if strings.Contains(typ, "reasoning") {
			kind = "reasoning"
		}
		return []frame{partUpdated(sid, map[string]any{
			"id": partKey(mid, int(getFloat(d, "ordinal"))), "messageID": mid, "type": kind, "text": "",
		})}

	case "session.text.delta", "session.reasoning.delta":
		mid := getStr(d, "assistantMessageID")
		return []frame{{"message.part.delta", map[string]any{
			"sessionID": sid, "messageID": mid, "partID": partKey(mid, int(getFloat(d, "ordinal"))),
			"field": "text", "delta": getStr(d, "delta"),
		}}}

	case "session.text.ended", "session.reasoning.ended":
		mid := getStr(d, "assistantMessageID")
		kind := "text"
		if strings.Contains(typ, "reasoning") {
			kind = "reasoning"
		}
		return []frame{partUpdated(sid, map[string]any{
			"id": partKey(mid, int(getFloat(d, "ordinal"))), "messageID": mid, "type": kind, "text": getStr(d, "text"),
		})}

	case "session.tool.input.started":
		mid, call, name := getStr(d, "assistantMessageID"), getStr(d, "id"), v1Name(getStr(d, "name"))
		st.mu.Lock()
		st.tools[mid+":"+call] = name
		st.mu.Unlock()
		return []frame{partUpdated(sid, map[string]any{
			"id": toolPartKey(mid, call), "messageID": mid, "type": "tool", "callID": call, "tool": name,
			"state": map[string]any{"status": "pending", "input": map[string]any{}},
		})}

	case "session.tool.called", "session.tool.progress":
		mid, call := getStr(d, "assistantMessageID"), getStr(d, "id")
		state := map[string]any{"status": "running", "input": map[string]any{}}
		if in := getMap(d, "input"); in != nil {
			state["input"] = in
			st.mu.Lock()
			st.inputs[mid+":"+call] = in
			st.mu.Unlock()
		}
		if md := getMap(d, "metadata"); md != nil {
			state["metadata"] = md
		}
		return []frame{partUpdated(sid, map[string]any{
			"id": toolPartKey(mid, call), "messageID": mid, "type": "tool", "callID": call, "tool": st.toolName(mid, call),
			"state": state,
		})}

	case "session.tool.success", "session.tool.failed":
		mid, call := getStr(d, "assistantMessageID"), getStr(d, "id")
		state := map[string]any{"status": "completed"}
		if typ == "session.tool.failed" {
			state["status"] = "error"
			state["error"] = map[string]any{"message": getStr(getMap(d, "error"), "message")}
		}
		name := st.toolName(mid, call)
		st.mu.Lock()
		if in := st.inputs[mid+":"+call]; in != nil {
			state["input"] = in // the success event carries no input; keep what the call had
		}
		delete(st.inputs, mid+":"+call)
		delete(st.tools, mid+":"+call)
		st.mu.Unlock()
		content := getSlice(d, "content")
		state["output"] = contentText(content)
		if files := contentFiles(content); len(files) > 0 {
			state["attachments"] = files
		}
		if md := getMap(d, "metadata"); md != nil {
			state["metadata"] = md
		}
		return []frame{partUpdated(sid, map[string]any{
			"id": toolPartKey(mid, call), "messageID": mid, "type": "tool", "callID": call, "tool": name,
			"state": state,
		})}

	case "permission.asked":
		p := v1Permission(d)
		if src := getMap(d, "source"); src != nil {
			st.mu.Lock()
			in := st.inputs[getStr(src, "messageID")+":"+getStr(src, "id")]
			st.mu.Unlock()
			addAskMetadata(p, in)
		}
		return []frame{{"permission.asked", p}}

	case "permission.replied":
		return []frame{{"permission.replied", map[string]any{
			"sessionID": sid, "requestID": getStr(d, "requestID"), "reply": getStr(d, "reply"),
		}}}

	case "form.created":
		if q, ok := v1Question(getMap(d, "form")); ok {
			return []frame{{"question.asked", q}}
		}
		return nil

	case "form.replied":
		return []frame{{"question.replied", map[string]any{
			"sessionID": getStr(d, "sessionID"), "requestID": getStr(d, "id"),
			"answers": toAnySlices(answersFromForm(getMap(d, "answer"))),
		}}}

	case "form.cancelled":
		return []frame{{"question.rejected", map[string]any{"sessionID": getStr(d, "sessionID"), "requestID": getStr(d, "id")}}}

	case "session.compaction.started":
		// The 1.x transcript marks a compaction with a part on a message of its
		// own. The 2.x message is only complete once the compaction ends, so
		// the live marker carries a provisional id (the input id when 2.x names
		// one) and the end re-reads the transcript.
		mid := getStr(d, "inputID")
		if mid == "" {
			mid = fmt.Sprintf("compaction_%s_%d", sid, int64(created))
		}
		info := map[string]any{"id": mid, "role": "user", "sessionID": sid, "time": map[string]any{"created": created}}
		return []frame{
			{"message.updated", map[string]any{"sessionID": sid, "info": info}},
			partUpdated(sid, map[string]any{"id": mid + ":compaction", "messageID": mid, "type": "compaction", "auto": getStr(d, "reason") == "auto"}),
		}

	case "session.compaction.ended", "session.compaction.failed":
		return []frame{{"session.compacted", map[string]any{"sessionID": sid}}}

	case "session.revert.staged", "session.revert.cleared", "session.revert.committed":
		return []frame{{"session.compacted", map[string]any{"sessionID": sid}}}
	}
	return nil
}

func (st *asmState) toolName(mid, call string) string {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.tools[mid+":"+call]
}

func toAnySlices(in [][]string) []any {
	out := make([]any, 0, len(in))
	for _, s := range in {
		row := make([]any, 0, len(s))
		for _, v := range s {
			row = append(row, v)
		}
		out = append(out, row)
	}
	return out
}

// jsonObject decodes raw into a map (nil on any error).
func jsonObject(raw []byte) map[string]any {
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	return m
}

// knownDirs is the set of directories sessions were seen in; the caller holds mu.
func (st *asmState) knownDirs() map[string]bool {
	if st.seen == nil {
		st.seen = map[string]bool{}
	}
	return st.seen
}

// seenDirs lists the directories seen so far.
func (st *asmState) seenDirs() []string {
	st.mu.Lock()
	defer st.mu.Unlock()
	out := make([]string, 0, len(st.seen))
	for d := range st.seen {
		out = append(out, d)
	}
	return out
}

// addAskMetadata gives a 1.x-shaped permission payload the facts 1.x put in its
// metadata and 2.x leaves to the tool call: a shell ask's whole command line
// (its resources are the split subcommands) and a file ask's path. in is the
// call's arguments.
func addAskMetadata(p map[string]any, in map[string]any) {
	if in == nil {
		return
	}
	md, _ := p["metadata"].(map[string]any)
	if md == nil {
		md = map[string]any{}
	}
	if cmd := getStr(in, "command"); cmd != "" && getStr(md, "command") == "" {
		md["command"] = cmd
	}
	if path := getStr(in, "path", "filePath"); path != "" && getStr(md, "filepath") == "" {
		md["filepath"] = path
	}
	p["metadata"] = md
}
