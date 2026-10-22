package main

import (
	"context"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
	"galopin/internal/files"
	"galopin/internal/link"
	"galopin/internal/mcpconn"
	"galopin/internal/policy"
	"galopin/internal/protofix"
	"galopin/internal/terminal"
	"galopin/internal/workspaces"
)

// The shared wire fixtures (agent/protocol-fixtures, README there): the same
// JSON files Cerea's server spec parses with its zod schemas. Here each is
// decoded into galopin's real structs, strictly (an unknown field is a
// mismatch), and re-marshalled to compare against the fixture; the ops are
// also run through the real dispatch. The completeness half enumerates what
// the code knows (the Handle switch, the event kind constants, the frame
// writers and readers, the codes opErrf emits) from the source and demands a
// fixture for each, so a new op without one fails.

// fxRetiredOps answer unsupported by design (PROTOCOL.md §6, "Retired"); they
// are in the dispatch table and deliberately have no fixture.
var fxRetiredOps = map[string]bool{"session.setAutoAccept": true, "session.setRules": true}

// eventKindsOffTheWire are backend event kinds eventToWire never renders: the
// materializer consumes resync itself.
var eventKindsOffTheWire = map[string]bool{"resync": true}

func fxParseGo(t *testing.T, path string) *ast.File {
	t.Helper()
	f, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func fxLit(e ast.Expr) (string, bool) {
	b, ok := e.(*ast.BasicLit)
	if !ok || b.Kind != token.STRING {
		return "", false
	}
	s, err := strconv.Unquote(b.Value)
	return s, err == nil
}

func fxSortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// dispatchedOps is every op machine.Handle's switch names.
func dispatchedOps(t *testing.T) map[string]bool {
	t.Helper()
	ops := map[string]bool{}
	for _, decl := range fxParseGo(t, "dispatch.go").Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "Handle" {
			continue
		}
		ast.Inspect(fn, func(n ast.Node) bool {
			sw, ok := n.(*ast.SwitchStmt)
			if !ok {
				return true
			}
			if tag, ok := sw.Tag.(*ast.Ident); !ok || tag.Name != "op" {
				return true
			}
			for _, stmt := range sw.Body.List {
				for _, e := range stmt.(*ast.CaseClause).List {
					if s, ok := fxLit(e); ok {
						ops[s] = true
					}
				}
			}
			return true
		})
	}
	if len(ops) < 40 {
		t.Fatalf("found only %d ops in Handle's switch: the enumeration is broken", len(ops))
	}
	return ops
}

func eventKinds(t *testing.T) map[string]bool {
	t.Helper()
	kinds := map[string]bool{}
	for _, decl := range fxParseGo(t, "internal/backend/types.go").Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.CONST {
			continue
		}
		for _, spec := range gen.Specs {
			vs := spec.(*ast.ValueSpec)
			if id, ok := vs.Type.(*ast.Ident); ok && id.Name == "EventKind" {
				for _, v := range vs.Values {
					if s, ok := fxLit(v); ok {
						kinds[s] = true
					}
				}
			}
		}
	}
	if len(kinds) < 10 {
		t.Fatalf("found only %d event kinds: the enumeration is broken", len(kinds))
	}
	return kinds
}

func nonTestGoFiles(t *testing.T, dirs ...string) []string {
	t.Helper()
	var out []string
	for _, d := range dirs {
		m, err := filepath.Glob(filepath.Join(d, "*.go"))
		if err != nil {
			t.Fatal(err)
		}
		for _, p := range m {
			if !strings.HasSuffix(p, "_test.go") {
				out = append(out, p)
			}
		}
	}
	return out
}

// frameTypesWritten is every "type" a map literal in the link package sets.
func frameTypesWritten(t *testing.T) map[string]bool {
	t.Helper()
	types := map[string]bool{}
	for _, p := range nonTestGoFiles(t, "internal/link") {
		ast.Inspect(fxParseGo(t, p), func(n ast.Node) bool {
			cl, ok := n.(*ast.CompositeLit)
			if !ok {
				return true
			}
			for _, el := range cl.Elts {
				kv, ok := el.(*ast.KeyValueExpr)
				if !ok {
					continue
				}
				if k, _ := fxLit(kv.Key); k == "type" {
					if v, ok := fxLit(kv.Value); ok {
						types[v] = true
					}
				}
			}
			return true
		})
	}
	return types
}

// frameTypesRead is every frame type the link's read loop switches on.
func frameTypesRead(t *testing.T) map[string]bool {
	t.Helper()
	types := map[string]bool{}
	ast.Inspect(fxParseGo(t, "internal/link/link.go"), func(n ast.Node) bool {
		fn, ok := n.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "serve" {
			return true
		}
		ast.Inspect(fn, func(n ast.Node) bool {
			if cc, ok := n.(*ast.CaseClause); ok {
				for _, e := range cc.List {
					if s, ok := fxLit(e); ok {
						types[s] = true
					}
				}
			}
			return true
		})
		return false
	})
	return types
}

// callOps is every schedule op galopin sends as a call.
func callOps(t *testing.T) map[string]bool {
	t.Helper()
	ops := map[string]bool{}
	ast.Inspect(fxParseGo(t, "agenttools_schedule.go"), func(n ast.Node) bool {
		c, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := c.Fun.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "cereaCall" || len(c.Args) < 3 {
			return true
		}
		if s, ok := fxLit(c.Args[2]); ok {
			ops["schedule."+s] = true
		}
		return true
	})
	return ops
}

// errorCodesEmitted is every res error code the Go source can send.
func errorCodesEmitted(t *testing.T) map[string]bool {
	t.Helper()
	codes := map[string]bool{
		// internal/files names its sentinels after the codes (dispatch maps them back).
		files.ErrInvalid.Error(): true, files.ErrForbidden.Error(): true,
		files.ErrNotFound.Error(): true, files.ErrTooLarge.Error(): true,
	}
	for _, p := range nonTestGoFiles(t, ".", "internal/link") {
		inDispatch := filepath.Base(p) == "dispatch.go"
		ast.Inspect(fxParseGo(t, p), func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.CallExpr:
				name := ""
				switch f := x.Fun.(type) {
				case *ast.Ident:
					name = f.Name
				case *ast.SelectorExpr:
					name = f.Sel.Name
				}
				idx := -1
				switch {
				case name == "opErrf", name == "refuse" && inDispatch:
					idx = 0
				case name == "sendError":
					idx = 2
				}
				if idx >= 0 && len(x.Args) > idx {
					if s, ok := fxLit(x.Args[idx]); ok {
						codes[s] = true
					}
				}
			case *ast.CompositeLit:
				if tn := fxExprName(x.Type); tn == "OpError" {
					for _, el := range x.Elts {
						if kv, ok := el.(*ast.KeyValueExpr); ok {
							if k, ok := kv.Key.(*ast.Ident); ok && k.Name == "Code" {
								if s, ok := fxLit(kv.Value); ok {
									codes[s] = true
								}
							}
						}
					}
				}
			}
			return true
		})
	}
	return codes
}

func fxExprName(e ast.Expr) string {
	switch x := e.(type) {
	case *ast.Ident:
		return x.Name
	case *ast.SelectorExpr:
		return x.Sel.Name
	}
	return ""
}

func fxFixtureSet(fixtures []protofix.Fixture, t *testing.T, pick func(protofix.Fixture, protofix.Header) (string, bool)) map[string]bool {
	out := map[string]bool{}
	for _, f := range fixtures {
		if s, ok := pick(f, f.Head(t)); ok {
			out[s] = true
		}
	}
	return out
}

func fxDiffSets(want, got map[string]bool) (missing, extra []string) {
	for k := range want {
		if !got[k] {
			missing = append(missing, k)
		}
	}
	for k := range got {
		if !want[k] {
			extra = append(extra, k)
		}
	}
	sort.Strings(missing)
	sort.Strings(extra)
	return
}

func TestProtocolFixturesAreComplete(t *testing.T) {
	fixtures := protofix.Load(t)

	t.Run("every dispatched op has a req and a res fixture", func(t *testing.T) {
		code := dispatchedOps(t)
		for op := range fxRetiredOps {
			if !code[op] {
				t.Errorf("retired op %s is no longer in Handle: drop it from fxRetiredOps", op)
			}
			delete(code, op)
		}
		req := fxFixtureSet(fixtures, t, func(f protofix.Fixture, h protofix.Header) (string, bool) {
			return h.Op, h.Type == "req"
		})
		res := fxFixtureSet(fixtures, t, func(f protofix.Fixture, h protofix.Header) (string, bool) {
			return f.Meta.Op, h.Type == "res" && h.OK != nil && *h.OK
		})
		for name, got := range map[string]map[string]bool{"req": req, "res": res} {
			missing, extra := fxDiffSets(code, got)
			if len(missing) > 0 {
				t.Errorf("ops with no %s fixture: %v", name, missing)
			}
			if len(extra) > 0 {
				t.Errorf("%s fixtures for ops Handle does not dispatch: %v", name, extra)
			}
		}
	})

	t.Run("retired ops still answer unsupported", func(t *testing.T) {
		mc := newTestMachine(t, &fakeBackend{})
		for _, op := range fxSortedKeys(fxRetiredOps) {
			_, operr := mc.Handle(context.Background(), op, json.RawMessage(`{}`))
			if operr == nil || operr.Code != "unsupported" || !strings.Contains(operr.Message, "retired") {
				t.Errorf("%s -> %+v", op, operr)
			}
		}
	})

	t.Run("every event kind has an event fixture", func(t *testing.T) {
		code := eventKinds(t)
		for k := range eventKindsOffTheWire {
			delete(code, k)
		}
		got := fxFixtureSet(fixtures, t, func(f protofix.Fixture, h protofix.Header) (string, bool) {
			if h.Type != "event" {
				return "", false
			}
			var e struct {
				Event struct{ Kind string } `json:"event"`
			}
			_ = json.Unmarshal(f.Frame, &e)
			return e.Event.Kind, true
		})
		missing, extra := fxDiffSets(code, got)
		if len(missing) > 0 || len(extra) > 0 {
			t.Errorf("event kinds without a fixture: %v; fixtures of kinds the code does not know: %v", missing, extra)
		}
	})

	t.Run("every frame type the link writes or reads has a fixture", func(t *testing.T) {
		dir := func(d string) map[string]bool {
			return fxFixtureSet(fixtures, t, func(f protofix.Fixture, h protofix.Header) (string, bool) {
				return h.Type, f.Meta.Direction == d
			})
		}
		written := frameTypesWritten(t)
		if missing, extra := fxDiffSets(written, dir("M→C")); len(missing)+len(extra) > 0 {
			t.Errorf("machine->Cerea frame types: written but no fixture %v; fixture but never written %v", missing, extra)
		}
		read := frameTypesRead(t)
		read["welcome"] = true // read by the handshake in runOnce, before serve
		if missing, extra := fxDiffSets(read, dir("C→M")); len(missing)+len(extra) > 0 {
			t.Errorf("Cerea->machine frame types: read but no fixture %v; fixture but never read %v", missing, extra)
		}
	})

	t.Run("every call op has a call and a callres fixture", func(t *testing.T) {
		code := callOps(t)
		for _, typ := range []string{"call", "callres"} {
			got := fxFixtureSet(fixtures, t, func(f protofix.Fixture, h protofix.Header) (string, bool) {
				if h.Type != typ || (typ == "callres" && h.OK != nil && !*h.OK) {
					return "", false
				}
				op := h.Op
				if typ == "callres" {
					op = f.Meta.Op
				}
				return op, true
			})
			if missing, extra := fxDiffSets(code, got); len(missing)+len(extra) > 0 {
				t.Errorf("%s fixtures: ops with none %v; fixtures for ops galopin never calls %v", typ, missing, extra)
			}
		}
	})

	t.Run("every error code galopin sends has a res error fixture", func(t *testing.T) {
		got := fxFixtureSet(fixtures, t, func(f protofix.Fixture, h protofix.Header) (string, bool) {
			return f.Meta.ErrorCode, h.Type == "res" && h.OK != nil && !*h.OK
		})
		for _, code := range fxSortedKeys(errorCodesEmitted(t)) {
			if !got[code] {
				t.Errorf("galopin can send res error code %q, which no fixture (and so PROTOCOL.md's set) has", code)
			}
		}
	})
}

// -- decoding ----------------------------------------------------------------

type fxEnvelopeWire struct {
	SessionID     string          `json:"sessionId"`
	Epoch         string          `json:"epoch"`
	Seq           int64           `json:"seq"`
	RootSessionID string          `json:"rootSessionId"`
	Event         json.RawMessage `json:"event"`
}

type fxWireEvent struct {
	Kind      string          `json:"kind"`
	Message   json.RawMessage `json:"message"`
	Part      *backend.Part   `json:"part"`
	MessageID string          `json:"messageId"`
	PartID    string          `json:"partId"`
	Role      string          `json:"role"`
	Field     string          `json:"field"`
	Delta     string          `json:"delta"`
	Status    string          `json:"status"`
	Detail    string          `json:"detail"`
	Retry     *backend.RetryInfo
	Request   json.RawMessage  `json:"request"`
	RequestID string           `json:"requestId"`
	Decision  string           `json:"decision"`
	By        string           `json:"by"`
	Usage     *backend.Usage   `json:"usage"`
	Session   *backend.Session `json:"session"`
	Code      string           `json:"code"`
	Todos     []backend.Todo   `json:"todos"`
	Answers   [][]string       `json:"answers"`
	Rejected  bool             `json:"rejected"`
}

// eventFromWire is eventToWire's inverse, strict: the fixture names only
// fields the wire shape has.
func eventFromWire(raw []byte) (backend.Event, error) {
	var w fxWireEvent
	if err := protofix.DecodeStrict(raw, &w); err != nil {
		return backend.Event{}, err
	}
	ev := backend.Event{Kind: backend.EventKind(w.Kind)}
	switch ev.Kind {
	case backend.EventMessage:
		var m backend.Message
		if err := protofix.DecodeStrict(w.Message, &m); err != nil {
			return ev, err
		}
		ev.Message = &m
	case backend.EventPart:
		ev.Part = w.Part
	case backend.EventDelta:
		ev.MessageID, ev.PartID, ev.Role, ev.Field, ev.Delta = w.MessageID, w.PartID, w.Role, w.Field, w.Delta
	case backend.EventPartRemoved:
		ev.MessageID, ev.PartID = w.MessageID, w.PartID
	case backend.EventStatus:
		ev.Status, ev.Detail, ev.Retry = backend.SessionStatus(w.Status), w.Detail, w.Retry
	case backend.EventPermissionAsked:
		var r backend.PermissionRequest
		if err := protofix.DecodeStrict(w.Request, &r); err != nil {
			return ev, err
		}
		ev.Request = &r
	case backend.EventPermissionReplied:
		ev.RequestID, ev.Decision, ev.By = w.RequestID, backend.Decision(w.Decision), w.By
	case backend.EventUsage:
		ev.Usage = w.Usage
	case backend.EventSession:
		ev.Session = w.Session
	case backend.EventError:
		if err := json.Unmarshal(w.Message, &ev.ErrorMessage); err != nil {
			return ev, err
		}
		ev.ErrorCode = w.Code
	case backend.EventTodo:
		ev.Todos = w.Todos
	case backend.EventQuestionAsked:
		var r backend.QuestionRequest
		if err := protofix.DecodeStrict(w.Request, &r); err != nil {
			return ev, err
		}
		ev.QuestionRequestID, ev.Questions, ev.QuestionCallID = r.ID, r.Questions, r.CallID
	case backend.EventQuestionResolved:
		ev.QuestionRequestID = w.RequestID
		if w.Rejected {
			ev.QuestionDecision = "rejected"
		} else {
			ev.QuestionAnswers = w.Answers
		}
	default:
		return ev, fmt.Errorf("unknown event kind %q", w.Kind)
	}
	return ev, nil
}

func checkEvent(t *testing.T, name string, raw []byte) {
	t.Helper()
	ev, err := eventFromWire(raw)
	if err != nil {
		t.Errorf("%s: does not decode: %v", name, err)
		return
	}
	out, err := json.Marshal(eventToWire(ev))
	if err != nil {
		t.Errorf("%s: %v", name, err)
		return
	}
	if err := protofix.Same(raw, out); err != nil {
		t.Errorf("%s: eventToWire does not reproduce the fixture: %v", name, err)
	}
}

type (
	fxEmptyResult   struct{}
	fxSessionResult struct {
		Session backend.Session `json:"session"`
	}
	fxSessionsResult struct {
		Sessions []backend.Session `json:"sessions"`
	}
	fxWorkspaceResult struct {
		Workspace workspaces.Workspace `json:"workspace"`
	}
	fxPendingResult struct {
		Permissions []struct {
			SessionID    string                    `json:"sessionId"`
			WorkspaceID  string                    `json:"workspaceId"`
			SessionTitle string                    `json:"sessionTitle"`
			RootID       string                    `json:"rootId,omitempty"`
			Request      backend.PermissionRequest `json:"request"`
		} `json:"permissions"`
		Questions []struct {
			SessionID    string                  `json:"sessionId"`
			WorkspaceID  string                  `json:"workspaceId"`
			SessionTitle string                  `json:"sessionTitle"`
			RootID       string                  `json:"rootId,omitempty"`
			Request      backend.QuestionRequest `json:"request"`
		} `json:"questions"`
	}
	fxRulesResult struct {
		Agent          string                  `json:"agent"`
		Mode           string                  `json:"mode"`
		Rules          []ruleView              `json:"rules"`
		SavedApprovals []backend.SavedApproval `json:"savedApprovals"`
		Ceiling        map[string]string       `json:"ceiling"`
		Coordination   []string                `json:"coordination"`
		SafeDirs       []string                `json:"safeDirs"`
	}
	fxHistoryResult struct {
		Messages []backend.TranscriptEntry `json:"messages"`
		HasMore  bool                      `json:"hasMore"`
		Before   string                    `json:"before"`
	}
	fxAttachResult struct {
		Terminal terminal.Snapshot `json:"terminal"`
		From     int64             `json:"from"`
		Reset    bool              `json:"reset"`
		Prelude  string            `json:"prelude,omitempty"`
	}
)

// resultTargets: the Go shape each op's result decodes into (the maps
// dispatch.go builds, as structs).
func resultTarget(op string) any {
	switch op {
	case "workspace.list":
		return &struct {
			Workspaces []workspaceView `json:"workspaces"`
		}{}
	case "workspace.suggest":
		return &struct {
			Directories []workspaces.Directory `json:"directories"`
		}{}
	case "workspace.create", "workspace.rename":
		return &fxWorkspaceResult{}
	case "session.list", "session.children":
		return &fxSessionsResult{}
	case "session.get", "session.create", "session.rename", "session.setMode", "session.setModel", "session.setEffort":
		return &fxSessionResult{}
	case "session.grantCoordination":
		return &struct {
			Keys []string `json:"keys"`
		}{}
	case "permission.reply":
		return &struct {
			AlreadyResolved bool `json:"alreadyResolved,omitempty"`
		}{}
	case "permission.rules":
		return &fxRulesResult{}
	case "permissions.pending":
		return &fxPendingResult{}
	case "session.history":
		return &fxHistoryResult{}
	case "session.diff":
		return &struct {
			Files []backend.FileDiff `json:"files"`
		}{}
	case "session.attachment":
		return &struct {
			Mime string `json:"mime"`
			Data string `json:"data"`
		}{}
	case "backend.modes":
		return &struct {
			Modes []backend.Mode `json:"modes"`
		}{}
	case "backend.models":
		return &struct {
			Models []backend.Model `json:"models"`
			Hidden int             `json:"hidden"`
		}{}
	case "backend.commands":
		return &struct {
			Commands []backend.Command `json:"commands"`
		}{}
	case "profiles.list", "profiles.set":
		return &profileSet{}
	case "files.list":
		return &files.ListResult{}
	case "files.stat":
		return &struct {
			Entry files.Entry `json:"entry"`
		}{}
	case "files.read":
		return &files.ReadResult{}
	case "files.status":
		return &files.StatusResult{}
	case "terminal.list":
		return &struct {
			Terminals []terminal.Snapshot `json:"terminals"`
		}{}
	case "terminal.open", "terminal.rename":
		return &struct {
			Terminal terminal.Snapshot `json:"terminal"`
		}{}
	case "terminal.attach":
		return &fxAttachResult{}
	case "terminal.resize":
		return &struct {
			Applied bool `json:"applied"`
		}{}
	case "mcp.list":
		return &struct {
			Servers []mcpconn.ServerView `json:"servers"`
		}{}
	case "mcp.open":
		return &struct {
			ChannelID string `json:"channelId"`
		}{}
	case "mcp.login":
		return &struct {
			AuthorizationURL string `json:"authorizationUrl"`
		}{}
	case "mcp.close", "mcp.loginComplete":
		return &fxEmptyResult{}
	case "workspace.archive", "session.prompt", "session.command", "session.cancel", "session.archive",
		"session.delete", "session.setPermissionMode", "permission.saved.remove", "question.reply",
		"session.compact", "session.revert", "session.unrevert", "terminal.detach", "terminal.close":
		return &fxEmptyResult{}
	}
	return nil
}

func TestProtocolFixturesDecodeIntoGoStructs(t *testing.T) {
	for _, f := range protofix.Load(t) {
		f := f
		h := f.Head(t)
		t.Run(f.File, func(t *testing.T) {
			switch h.Type {
			case "hello":
				var hello link.Hello
				body := protofix.Strip(f.Frame, "type", "protocol", "credential")
				if !f.Meta.Emitted() {
					if err := json.Unmarshal(body, &hello); err != nil {
						t.Fatal(err)
					}
					return
				}
				if err := protofix.DecodeStrict(body, &hello); err != nil {
					t.Fatalf("does not decode into link.Hello: %v", err)
				}
				out, _ := json.Marshal(hello)
				if err := protofix.Same(body, out); err != nil {
					t.Fatalf("link.Hello does not reproduce the fixture: %v", err)
				}
			case "event":
				var e fxEnvelopeWire
				if err := protofix.DecodeStrict(protofix.Strip(f.Frame, "type"), &e); err != nil {
					t.Fatal(err)
				}
				checkEvent(t, f.File, e.Event)
			case "notice":
				checkNotice(t, f)
			case "mcp":
				checkMcpFrame(t, f)
			case "res":
				checkRes(t, f, h)
			case "call", "callres", "req", "welcome", "status", "credential", "auth":
				// Exercised against the real link (internal/link fixtures_test.go) and,
				// for req, the real dispatch (TestProtocolFixtureReqsThroughHandle).
			default:
				t.Fatalf("frame type %q has no check here", h.Type)
			}
		})
	}
}

// checkMcpFrame: an mcp frame (PROTOCOL.md §10.3) carries a channel and
// exactly one of a JSON-RPC message and a closed object; the closed object
// re-marshals from Go's shape, a null detail included.
func checkMcpFrame(t *testing.T, f protofix.Fixture) {
	t.Helper()
	var m struct {
		ChannelID string          `json:"channelId"`
		Message   json.RawMessage `json:"message"`
		Closed    *struct {
			Reason string  `json:"reason"`
			Detail *string `json:"detail"`
		} `json:"closed"`
	}
	if err := protofix.DecodeStrict(protofix.Strip(f.Frame, "type"), &m); err != nil {
		t.Fatal(err)
	}
	if m.ChannelID == "" || (m.Message == nil) == (m.Closed == nil) {
		t.Fatalf("an mcp frame has a channelId and one of message and closed: %s", f.Frame)
	}
	if m.Closed != nil {
		switch m.Closed.Reason {
		case "exited", "crashed", "idle", "closed", "config":
		default:
			t.Fatalf("closed reason %q", m.Closed.Reason)
		}
		out, _ := json.Marshal(m.Closed)
		if err := protofix.Same(protofix.Field(f.Frame, "closed"), out); err != nil {
			t.Fatalf("closed does not reproduce the fixture: %v", err)
		}
		return
	}
	var rpc struct {
		JSONRPC string `json:"jsonrpc"`
	}
	if err := json.Unmarshal(m.Message, &rpc); err != nil || rpc.JSONRPC != "2.0" {
		t.Fatalf("message is not JSON-RPC 2.0: %s", m.Message)
	}
}

func checkNotice(t *testing.T, f protofix.Fixture) {
	t.Helper()
	var n struct {
		Scope map[string]string `json:"scope"`
		Event json.RawMessage   `json:"event"`
	}
	if err := protofix.DecodeStrict(protofix.Strip(f.Frame, "type"), &n); err != nil {
		t.Fatal(err)
	}
	var kind struct {
		Kind string `json:"kind"`
	}
	_ = json.Unmarshal(n.Event, &kind)
	if kind.Kind == "files.changed" {
		// The watcher that would send it is not built (PROTOCOL.md §9.3
		// files.watch); the shape is pinned here and in Cerea's schema.
		var c struct {
			Kind     string   `json:"kind"`
			Paths    []string `json:"paths"`
			Overflow bool     `json:"overflow"`
		}
		if err := protofix.DecodeStrict(n.Event, &c); err != nil {
			t.Fatal(err)
		}
		return
	}
	var notice terminal.Notice
	if err := protofix.DecodeStrict(n.Event, &notice); err != nil {
		t.Fatalf("does not decode into terminal.Notice: %v", err)
	}
	out, _ := json.Marshal(notice)
	if err := protofix.Same(n.Event, out); err != nil {
		t.Fatalf("terminal.Notice does not reproduce the fixture: %v", err)
	}
}

func checkRes(t *testing.T, f protofix.Fixture, h protofix.Header) {
	t.Helper()
	if h.OK != nil && !*h.OK {
		var e struct {
			Error struct{ Code, Message string } `json:"error"`
		}
		if err := json.Unmarshal(f.Frame, &e); err != nil {
			t.Fatal(err)
		}
		if e.Error.Code != f.Meta.ErrorCode || e.Error.Message == "" {
			t.Fatalf("error fixture says %+v", e.Error)
		}
		if !errorCodesEmitted(t)[e.Error.Code] {
			t.Logf("code %q is in the protocol but no Go source emits it today", e.Error.Code)
		}
		return
	}
	result := protofix.Field(f.Frame, "result")
	if f.Meta.Op == "session.sync" {
		checkSync(t, f, result)
		return
	}
	target := resultTarget(f.Meta.Op)
	if target == nil {
		t.Fatalf("no Go result shape for op %q: add it to resultTarget", f.Meta.Op)
	}
	if err := protofix.DecodeStrict(result, target); err != nil {
		t.Fatalf("result does not decode into %T: %v", target, err)
	}
	if !f.Meta.Rounds() {
		return
	}
	out, err := json.Marshal(target)
	if err != nil {
		t.Fatal(err)
	}
	if err := protofix.Same(result, out); err != nil {
		t.Fatalf("%T does not reproduce the fixture: %v", target, err)
	}
}

// checkSync decodes session.sync's two answers: a batch of envelopes (each
// event re-rendered through eventToWire) or a snapshot.
func checkSync(t *testing.T, f protofix.Fixture, result json.RawMessage) {
	t.Helper()
	var head struct {
		Epoch    string            `json:"epoch"`
		Seq      int64             `json:"seq"`
		Events   []json.RawMessage `json:"events"`
		Snapshot json.RawMessage   `json:"snapshot"`
	}
	if err := protofix.DecodeStrict(result, &head); err != nil {
		t.Fatal(err)
	}
	if head.Snapshot == nil {
		if head.Events == nil {
			t.Fatal("neither events nor snapshot")
		}
		for i, raw := range head.Events {
			var e fxEnvelopeWire
			if err := protofix.DecodeStrict(raw, &e); err != nil {
				t.Fatalf("events[%d]: %v", i, err)
			}
			checkEvent(t, fmt.Sprintf("events[%d]", i), e.Event)
		}
		return
	}
	var paging struct {
		HasMore *bool  `json:"hasMore"`
		Before  string `json:"before"`
	}
	if err := json.Unmarshal(head.Snapshot, &paging); err != nil {
		t.Fatal(err)
	}
	body := protofix.Strip(head.Snapshot, "hasMore", "before")
	var tr backend.Transcript
	if err := protofix.DecodeStrict(body, &tr); err != nil {
		t.Fatalf("snapshot does not decode into backend.Transcript: %v", err)
	}
	out, err := json.Marshal(tr)
	if err != nil {
		t.Fatal(err)
	}
	if err := protofix.Same(body, out); err != nil {
		t.Fatalf("backend.Transcript does not reproduce the snapshot: %v", err)
	}
}

// -- capabilities -------------------------------------------------------------

// The hello fixture's capability keys are exactly the ones buildHello sends.
func TestHelloFixtureCapabilitiesMatchBuildHello(t *testing.T) {
	var fixture link.Hello
	for _, f := range protofix.Load(t) {
		if f.File == "frames/hello.json" {
			if err := json.Unmarshal(protofix.Strip(f.Frame, "type", "protocol", "credential"), &fixture); err != nil {
				t.Fatal(err)
			}
		}
	}
	built := buildHello(allCapsBackend{}, policy.Default())
	want, got := map[string]bool{}, map[string]bool{}
	for k := range built.Backends[0].Capabilities {
		want[k] = true
	}
	for k := range fixture.Backends[0].Capabilities {
		got[k] = true
	}
	if missing, extra := fxDiffSets(want, got); len(missing)+len(extra) > 0 {
		t.Errorf("hello capabilities: fixture lacks %v, fixture has %v that buildHello does not send", missing, extra)
	}
	wantM, gotM := map[string]bool{}, map[string]bool{}
	for k := range built.Machine.Capabilities {
		wantM[k] = true
	}
	for k := range fixture.Machine.Capabilities {
		gotM[k] = true
	}
	if missing, extra := fxDiffSets(wantM, gotM); len(missing)+len(extra) > 0 {
		t.Errorf("machine capabilities: fixture lacks %v, fixture has %v that buildHello does not send", missing, extra)
	}
	// An unconfigured policy must not put a null on the wire: Cerea's hello
	// schema rejects it and the link never pairs.
	body, _ := json.Marshal(buildHello(allCapsBackend{}, policy.Policy{}))
	if protofix.ContainsNull(body) {
		t.Errorf("hello from the zero policy carries a null: %s", body)
	}
}

// -- req -> real dispatch ------------------------------------------------------

type fxStubBackend struct{ session backend.Session }

func (b *fxStubBackend) ID() string      { return "stub" }
func (b *fxStubBackend) Version() string { return "0.0.0" }
func (b *fxStubBackend) Capabilities() backend.Capabilities {
	return backend.Capabilities{Diff: true, Children: true, Usage: true, Compact: true, Images: true, Files: true, Questions: true, Revert: true, RevertFiles: true, Efforts: true, Commands: true, ToolImages: true, AgentTools: true, Steer: true, Permissions: true, CoordinationGrant: true, HistoryPaging: true}
}
func (b *fxStubBackend) ListSessions(context.Context, string) ([]backend.Session, error) {
	return []backend.Session{b.session}, nil
}
func (b *fxStubBackend) GetSession(context.Context, string, string) (backend.Session, error) {
	return b.session, nil
}
func (b *fxStubBackend) CreateSession(context.Context, string, backend.CreateSessionOptions) (backend.Session, error) {
	return b.session, nil
}
func (b *fxStubBackend) RenameSession(context.Context, string, string, string) (backend.Session, error) {
	return b.session, nil
}
func (b *fxStubBackend) DeleteSession(context.Context, string, string) error { return nil }
func (b *fxStubBackend) Prompt(context.Context, string, string, backend.Prompt) error {
	return nil
}
func (b *fxStubBackend) Cancel(context.Context, string, string) error { return nil }
func (b *fxStubBackend) SetMode(context.Context, string, string, string) (backend.Session, error) {
	return b.session, nil
}
func (b *fxStubBackend) SetModel(context.Context, string, string, string) (backend.Session, error) {
	return b.session, nil
}
func (b *fxStubBackend) ReplyPermission(context.Context, string, string, string, backend.Decision, string) error {
	return nil
}
func (b *fxStubBackend) Modes(context.Context, string) ([]backend.Mode, error)   { return nil, nil }
func (b *fxStubBackend) Models(context.Context, string) ([]backend.Model, error) { return nil, nil }
func (b *fxStubBackend) Transcript(context.Context, string, string) (backend.Transcript, error) {
	return backend.Transcript{}, nil
}
func (b *fxStubBackend) Subscribe(context.Context) (<-chan backend.BackendEvent, error) {
	return make(chan backend.BackendEvent), nil
}

// reqExceptions are fixtures whose args are well-formed but which the machine
// refuses for a reason of this rig's, not of the shape: the worktree needs a
// real git repo to branch from.
var reqExceptions = map[string]string{
	"ops/workspace.create.req.worktree.json": "needs a real git repository to branch from",
	"ops/workspace.archive.req.json":         "removeWorktree on a plain directory is refused by design (the rig's workspace is no worktree)",
}

// Every req fixture's args pass the real decoders of the real dispatch: no op
// answers invalid (bad arguments) or unknown op for them. Rewrites the
// fixtures' workspace and path stand-ins for the rig's real ones.
func TestProtocolFixtureReqsThroughHandle(t *testing.T) {
	for _, f := range protofix.Load(t) {
		h := f.Head(t)
		if h.Type != "req" {
			continue
		}
		f := f
		t.Run(f.File, func(t *testing.T) {
			back := &fxStubBackend{session: backend.Session{ID: "ses_01", Backend: "stub", Status: backend.StatusIdle}}
			mc := newTestMachine(t, back)
			dir := t.TempDir()
			w, err := mc.workspaces.Create("ws", dir, nil)
			if err != nil {
				t.Fatal(err)
			}
			for _, id := range []string{"ses_01", "ses_02"} {
				mc.trackSession(w, backend.Session{ID: id, Backend: "stub", Status: backend.StatusIdle})
			}
			t.Cleanup(func() { mc.terminals.CloseAll(true) })

			var req struct {
				Op   string          `json:"op"`
				Args json.RawMessage `json:"args"`
			}
			if err := json.Unmarshal(f.Frame, &req); err != nil {
				t.Fatal(err)
			}
			args := strings.NewReplacer(`"ws_01"`, strconv.Quote(w.ID), `"/home/dev/cerea"`, strconv.Quote(dir)).Replace(string(req.Args))
			_, operr := mc.Handle(context.Background(), req.Op, json.RawMessage(args))
			if operr == nil {
				return
			}
			if why, ok := reqExceptions[f.File]; ok {
				t.Logf("excepted (%s): %+v", why, operr)
				return
			}
			if operr.Code == "invalid" || strings.Contains(operr.Message, "unknown op") {
				t.Errorf("%s: the machine refuses the fixture's args: %s: %s", req.Op, operr.Code, operr.Message)
			}
		})
	}
}

// The fixtures above start from JSON, so a Go value that was never given a
// field (a nil slice, an empty string) is invisible to them. These start from
// the Go side: values built the way galopin builds them, with nothing optional
// set, must marshal to the spec's shapes the fixtures hold: a null where the
// spec says null, an array where it says array, a false that is not dropped.
func TestGoValuesMarshalToTheSpecFixtures(t *testing.T) {
	fixtures := protofix.Load(t)
	pick := func(file string, path ...string) json.RawMessage {
		t.Helper()
		for _, f := range fixtures {
			if f.File != file {
				continue
			}
			raw := json.RawMessage(f.Frame)
			for _, key := range path {
				if n, err := strconv.Atoi(key); err == nil {
					var arr []json.RawMessage
					if err := json.Unmarshal(raw, &arr); err != nil || n >= len(arr) {
						t.Fatalf("%s: no index %s", file, key)
					}
					raw = arr[n]
					continue
				}
				raw = protofix.Field(raw, key)
				if raw == nil {
					t.Fatalf("%s: no field %s", file, key)
				}
			}
			return raw
		}
		t.Fatalf("missing fixture %s", file)
		return nil
	}
	t0, _ := time.Parse(time.RFC3339, "2026-10-22T09:00:00Z")
	cases := []struct {
		name string
		want json.RawMessage
		got  any
	}{
		{"a session with nothing optional set", pick("events/session.minimal.json", "event", "session"),
			backend.Session{ID: "ses_03", WorkspaceID: "ws_01", Backend: "opencode", Status: backend.StatusIdle, CreatedAt: t0, UpdatedAt: t0}},
		{"a galopin ask with empty lists", pick("events/permission.asked.galopin.json", "event", "request"),
			backend.PermissionRequest{ID: "gp_01", SessionID: "ses_01", Tool: "session_read", Title: "Read session ses_02", Metadata: map[string]any{"galopin": true}, CallID: "call_07"}},
		{"a manual compaction part", pick("events/part.compaction.manual.json", "event", "part"),
			backend.Part{ID: "prt_07", MessageID: "msg_02", Role: "assistant", Type: backend.PartCompaction}},
		{"a fresh session's snapshot", pick("ops/session.sync.res.snapshot-empty.json", "result", "snapshot"),
			backend.Transcript{Status: backend.StatusIdle}},
		{"a command with no origin and an unknown shell", pick("ops/backend.commands.res.null.json", "result", "commands", "0"),
			backend.Command{Name: "mystery", Source: "skill"}},
		{"a free-text question", pick("events/question.asked.no-options.json", "event"),
			eventToWire(backend.Event{Kind: backend.EventQuestionAsked, QuestionRequestID: "que_02", Questions: []backend.QuestionItem{{Question: "Anything else?"}}})},
	}
	for _, c := range cases {
		out, err := json.Marshal(c.got)
		if err != nil {
			t.Fatal(err)
		}
		if err := protofix.Same(c.want, out); err != nil {
			t.Errorf("%s: %v", c.name, err)
		}
	}
}

// A connectors machine's hello (galopin run --connectors-only) has the shape of
// hello.connectors.json: no backends, mode connectors, the same capability
// keys with only mcp true, the same policy keys, and no null.
func TestConnectorsHelloMatchesItsFixture(t *testing.T) {
	var fixture link.Hello
	var fixtureFrame json.RawMessage
	for _, f := range protofix.Load(t) {
		if f.File == "frames/hello.connectors.json" {
			fixtureFrame = f.Frame
			if err := protofix.DecodeStrict(protofix.Strip(f.Frame, "type", "protocol", "credential"), &fixture); err != nil {
				t.Fatal(err)
			}
		}
	}
	built := buildConnectorsHello(policy.Policy{})
	body, _ := json.Marshal(built)
	if protofix.ContainsNull(body) {
		t.Errorf("connectors hello carries a null: %s", body)
	}
	if built.Machine.Mode != fixture.Machine.Mode || len(built.Backends) != 0 || built.Backends == nil {
		t.Errorf("mode %q backends %#v", built.Machine.Mode, built.Backends)
	}
	want, got := map[string]bool{}, map[string]bool{}
	for k, v := range built.Machine.Capabilities {
		want[k] = true
		if v != (k == "mcp") {
			t.Errorf("capability %s = %v", k, v)
		}
	}
	for k := range fixture.Machine.Capabilities {
		got[k] = true
	}
	if missing, extra := fxDiffSets(want, got); len(missing)+len(extra) > 0 {
		t.Errorf("capabilities: fixture lacks %v, fixture has %v that buildConnectorsHello does not send", missing, extra)
	}
	var wantPolicy, gotPolicy map[string]json.RawMessage
	_ = json.Unmarshal(protofix.Field(fixtureFrame, "policy"), &wantPolicy)
	_ = json.Unmarshal(protofix.Field(body, "policy"), &gotPolicy)
	pw, pg := map[string]bool{}, map[string]bool{}
	for k := range wantPolicy {
		pw[k] = true
	}
	for k := range gotPolicy {
		pg[k] = true
	}
	delete(pw, "warnings") // optional
	delete(pg, "warnings")
	if missing, extra := fxDiffSets(pw, pg); len(missing)+len(extra) > 0 {
		t.Errorf("policy keys: fixture has %v that the hello lacks, hello has %v the fixture lacks", missing, extra)
	}
}
