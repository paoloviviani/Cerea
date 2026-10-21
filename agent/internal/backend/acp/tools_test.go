package acp

import (
	"context"
	"sync"
	"testing"
	"time"

	"galopin/internal/backend"
)

type fakeEndpoint struct {
	mu      sync.Mutex
	session string
	revoked bool
}

func (e *fakeEndpoint) URL() string   { return "http://127.0.0.1:1/mcp/abc" }
func (e *fakeEndpoint) Token() string { return "tok" }
func (e *fakeEndpoint) Bind(id string) {
	e.mu.Lock()
	e.session = id
	e.mu.Unlock()
}
func (e *fakeEndpoint) Revoke() {
	e.mu.Lock()
	e.revoked = true
	e.mu.Unlock()
}

type fakeIssuer struct {
	mu      sync.Mutex
	minted  []*fakeEndpoint
	revoked []string
}

func (i *fakeIssuer) Mint() backend.MCPEndpoint {
	i.mu.Lock()
	defer i.mu.Unlock()
	e := &fakeEndpoint{}
	i.minted = append(i.minted, e)
	return e
}
func (i *fakeIssuer) RevokeSession(id string) {
	i.mu.Lock()
	i.revoked = append(i.revoked, id)
	i.mu.Unlock()
}

func TestCreateSessionHandsTheAgentItsOwnMCPServer(t *testing.T) {
	b, fa := newTestBackendWith(t, true, true)
	iss := &fakeIssuer{}
	b.SetMCPIssuer(iss)
	if caps := b.Capabilities(); !caps.AgentTools || !caps.ScheduleTools || !caps.CoordinationGrant {
		t.Fatalf("capabilities = %+v, want the tools advertised", caps)
	}
	s, err := b.CreateSession(context.Background(), "/w", backend.CreateSessionOptions{Title: "t", SpawnedBy: &backend.SpawnedBy{SessionID: "parent"}})
	if err != nil {
		t.Fatal(err)
	}
	p := <-fa.newParams
	servers, _ := p["mcpServers"].([]any)
	if len(servers) != 1 {
		t.Fatalf("mcpServers = %v", p["mcpServers"])
	}
	srv := servers[0].(map[string]any)
	hdrs := srv["headers"].([]any)[0].(map[string]any)
	if srv["type"] != "http" || srv["url"] != "http://127.0.0.1:1/mcp/abc" || hdrs["name"] != "Authorization" || hdrs["value"] != "Bearer tok" {
		t.Fatalf("server = %v", srv)
	}
	if len(iss.minted) != 1 || iss.minted[0].session != s.ID {
		t.Fatalf("the endpoint is not bound to the new session %q: %+v", s.ID, iss.minted)
	}
	if got := b.SpawnMarks()[s.ID]; got.SessionID != "parent" || s.SpawnedBy == nil {
		t.Fatalf("spawn marks = %+v session = %+v", b.SpawnMarks(), s)
	}
	// Deleting the session revokes its endpoint.
	if err := b.DeleteSession(context.Background(), "/w", s.ID); err != nil {
		t.Fatal(err)
	}
	if !iss.minted[0].revoked || len(iss.revoked) != 1 || iss.revoked[0] != s.ID {
		t.Fatalf("endpoint not revoked: %+v %v", iss.minted[0], iss.revoked)
	}
}

func TestNoMCPServerWhenTheAgentCannotUseOne(t *testing.T) {
	for name, c := range map[string]struct{ tools, http bool }{"agent without http mcp": {true, false}, "tools off": {false, true}} {
		b, fa := newTestBackendWith(t, c.tools, c.http)
		iss := &fakeIssuer{}
		b.SetMCPIssuer(iss)
		if b.Capabilities().AgentTools {
			t.Errorf("%s: agentTools advertised", name)
		}
		if _, err := b.CreateSession(context.Background(), "/w", backend.CreateSessionOptions{}); err != nil {
			t.Fatal(err)
		}
		p := <-fa.newParams
		if s, _ := p["mcpServers"].([]any); len(s) != 0 || len(iss.minted) != 0 {
			t.Errorf("%s: mcpServers = %v, minted %d", name, p["mcpServers"], len(iss.minted))
		}
	}
}

func TestGalopinAskIsHeldAndAnswered(t *testing.T) {
	b, _ := newTestBackendWith(t, true, true)
	ch := make(chan backend.BackendEvent, 8)
	evs, err := b.Subscribe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for e := range evs {
			ch <- e
		}
	}()
	type res struct {
		d   backend.Decision
		msg string
		err error
	}
	done := make(chan res, 1)
	go func() {
		d, m, err := b.Ask(context.Background(), "/w", "s1", backend.PermissionRequest{Tool: "session_spawn", Title: "x"})
		done <- res{d, m, err}
	}()
	var asked backend.BackendEvent
	select {
	case asked = <-ch:
	case <-time.After(3 * time.Second):
		t.Fatal("no permission.asked event")
	}
	req := asked.Event.Request
	if asked.Event.Kind != backend.EventPermissionAsked || req == nil || !isGalopinAsk(req.ID) || req.Metadata["galopin"] != true {
		t.Fatalf("event = %+v", asked)
	}
	// Another session cannot answer it.
	if err := b.ReplyPermission(context.Background(), "/w", "other", req.ID, backend.DecisionOnce, ""); !backend.IsNotFound(err) {
		t.Fatalf("reply from another session: %v", err)
	}
	if err := b.ReplyPermission(context.Background(), "/w", "s1", req.ID, backend.DecisionAlways, ""); err != nil {
		t.Fatal(err)
	}
	r := <-done
	if r.err != nil || r.d != backend.DecisionOnce { // always is read as once
		t.Fatalf("answer = %+v", r)
	}
	if err := b.ReplyPermission(context.Background(), "/w", "s1", req.ID, backend.DecisionOnce, ""); !backend.IsNotFound(err) {
		t.Fatalf("second reply: %v", err)
	}
}

func TestGalopinAskIsWithdrawnWhenTheCallIsAborted(t *testing.T) {
	b, _ := newTestBackendWith(t, true, true)
	evs, _ := b.Subscribe(context.Background())
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, _, err := b.Ask(ctx, "/w", "s1", backend.PermissionRequest{Tool: "session_send"})
		done <- err
	}()
	var id string
	select {
	case e := <-evs:
		id = e.Event.Request.ID
	case <-time.After(3 * time.Second):
		t.Fatal("no ask")
	}
	cancel()
	if err := <-done; err == nil {
		t.Fatal("an aborted ask returned no error")
	}
	select {
	case e := <-evs:
		if e.Event.Kind != backend.EventPermissionReplied || e.Event.RequestID != id || e.Event.Decision != backend.DecisionReject {
			t.Fatalf("withdrawal event = %+v", e.Event)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the card was not withdrawn")
	}
}

func TestPromptCarriesThePrefaceAndTheSender(t *testing.T) {
	b, fa := newTestBackendWith(t, true, true)
	s, err := b.CreateSession(context.Background(), "/w", backend.CreateSessionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	<-fa.newParams
	err = b.Prompt(context.Background(), "/w", s.ID, backend.Prompt{
		Text: "the report", Preface: "[from galopin]", SentBy: &backend.MessageSender{SessionID: "d1", Title: "D"},
	})
	if err != nil {
		t.Fatal(err)
	}
	p := <-fa.promptParams
	blocks, _ := p["prompt"].([]any)
	if len(blocks) != 2 || blocks[0].(map[string]any)["text"] != "[from galopin]" || blocks[1].(map[string]any)["text"] != "the report" {
		t.Fatalf("prompt blocks = %v", p["prompt"])
	}
	tr, _ := b.Transcript(context.Background(), "/w", s.ID)
	if len(tr.Messages) == 0 || tr.Messages[0].Message.SentBy == nil || tr.Messages[0].Message.SentBy.SessionID != "d1" {
		t.Fatalf("the message is not marked with its sender: %+v", tr.Messages)
	}
	if tr.Messages[0].Parts[0].Text != "the report" {
		t.Fatalf("the preface leaked into the transcript: %+v", tr.Messages[0].Parts)
	}
}
