package mcpconn

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeHTTPServer is a small MCP server over Streamable HTTP, with the OAuth
// endpoints of an authorization server on the same origin.
type fakeHTTPServer struct {
	t        *testing.T
	srv      *httptest.Server
	needAuth bool

	mu          sync.Mutex
	deletes     int
	sessionOK   int
	sawHeaders  []string
	refreshes   int
	codes       map[string]string // code -> challenge
	registered  []map[string]any
	goodToken   string
	postStatus  int // when set, every POST answers it
	getAttempts int
}

func newFakeHTTPServer(t *testing.T, needAuth bool) *fakeHTTPServer {
	f := &fakeHTTPServer{t: t, needAuth: needAuth, codes: map[string]string{}, goodToken: "good"}
	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", f.mcp)
	mux.HandleFunc("/.well-known/oauth-protected-resource", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"resource": f.srv.URL + "/mcp", "authorization_servers": []string{f.srv.URL}, "scopes_supported": []string{"read"}})
	})
	mux.HandleFunc("/.well-known/oauth-authorization-server", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"issuer": f.srv.URL, "authorization_endpoint": f.srv.URL + "/authorize",
			"token_endpoint": f.srv.URL + "/token", "registration_endpoint": f.srv.URL + "/register",
			"code_challenge_methods_supported": []string{"S256"}})
	})
	mux.HandleFunc("/register", func(w http.ResponseWriter, r *http.Request) {
		var m map[string]any
		json.NewDecoder(r.Body).Decode(&m)
		f.mu.Lock()
		f.registered = append(f.registered, m)
		f.mu.Unlock()
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]any{"client_id": "cid-1"})
	})
	mux.HandleFunc("/authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("response_type") != "code" || q.Get("client_id") != "cid-1" || q.Get("code_challenge_method") != "S256" ||
			q.Get("resource") != f.srv.URL+"/mcp" || !strings.HasPrefix(q.Get("redirect_uri"), "http://127.0.0.1:") {
			http.Error(w, "bad authorize request: "+r.URL.RawQuery, 400)
			return
		}
		f.mu.Lock()
		f.codes["code-1"] = q.Get("code_challenge")
		f.mu.Unlock()
		http.Redirect(w, r, q.Get("redirect_uri")+"?code=code-1&state="+url.QueryEscape(q.Get("state")), http.StatusFound)
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.Form.Get("grant_type") {
		case "authorization_code":
			sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
			if f.codes[r.Form.Get("code")] != base64.RawURLEncoding.EncodeToString(sum[:]) {
				w.WriteHeader(400)
				json.NewEncoder(w).Encode(map[string]any{"error": "invalid_grant", "error_description": "bad verifier"})
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"access_token": f.goodToken, "refresh_token": "r1", "expires_in": 3600, "token_type": "Bearer"})
		case "refresh_token":
			if r.Form.Get("refresh_token") != "r1" {
				w.WriteHeader(400)
				json.NewEncoder(w).Encode(map[string]any{"error": "invalid_grant"})
				return
			}
			f.refreshes++
			f.goodToken = "good-refreshed"
			json.NewEncoder(w).Encode(map[string]any{"access_token": f.goodToken, "expires_in": 3600, "token_type": "Bearer"})
		}
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeHTTPServer) mcp(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	good := f.goodToken
	postStatus := f.postStatus
	f.sawHeaders = append(f.sawHeaders, r.Method+" "+r.Header.Get("X-Test")+" "+r.Header.Get("Authorization"))
	f.mu.Unlock()
	if f.needAuth && r.Header.Get("Authorization") != "Bearer "+good {
		w.Header().Set("WWW-Authenticate", `Bearer resource_metadata="`+f.srv.URL+`/.well-known/oauth-protected-resource"`)
		w.WriteHeader(401)
		return
	}
	switch r.Method {
	case http.MethodDelete:
		f.mu.Lock()
		f.deletes++
		f.mu.Unlock()
		return
	case http.MethodGet:
		f.mu.Lock()
		f.getAttempts++
		f.mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "id: 1\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		return
	}
	if postStatus != 0 {
		http.Error(w, "upstream trouble", postStatus)
		return
	}
	body, _ := io.ReadAll(r.Body)
	var m struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	json.Unmarshal(body, &m)
	if m.Method == "ping" && string(m.ID) == `"galopin-probe"` {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"jsonrpc":"2.0","id":"galopin-probe","error":{"code":-32600,"message":"not initialized"}}`)
		return
	}
	if m.Method != "initialize" {
		if r.Header.Get("Mcp-Session-Id") != "sess-1" || r.Header.Get("MCP-Protocol-Version") != "2025-06-18" {
			http.Error(w, "missing session or protocol version", 400)
			return
		}
		f.mu.Lock()
		f.sessionOK++
		f.mu.Unlock()
	}
	switch m.Method {
	case "initialize":
		w.Header().Set("Mcp-Session-Id", "sess-1")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"httpfake","version":"1"},"capabilities":{}}}`, m.ID)
	case "notifications/initialized":
		w.WriteHeader(202)
	case "tools/list":
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"search"},{"name":"delete_all"}]}}`, m.ID)
	case "tools/call":
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{\"progress\":1}}\n\n")
		w.(http.Flusher).Flush()
		fmt.Fprintf(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"found\"}]}}\n\n", m.ID)
	default:
		w.WriteHeader(202)
	}
}

func (f *fakeHTTPServer) config(extra string) string {
	return fmt.Sprintf(`{"mcpServers":{"web":{"type":"http","url":%q,"headers":{"X-Test":"${FAKE}"}%s}}}`, f.srv.URL+"/mcp", extra)
}

func (r *rig) waitFrame(pred func(map[string]json.RawMessage) bool) map[string]json.RawMessage {
	r.t.Helper()
	for {
		f := r.next()
		var m map[string]json.RawMessage
		if json.Unmarshal(f.message, &m) == nil && pred(m) {
			return m
		}
	}
}

func TestHTTPChannelPassesThroughSessionHeadersAndStreams(t *testing.T) {
	f := newFakeHTTPServer(t, false)
	r := newRig(t, f.config(`, "allowedTools": ["search"]`), nil)
	ch := r.open("web")

	init := r.call(ch, 1, "initialize", `{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}`)
	if !strings.Contains(string(init["result"]), "httpfake") {
		t.Fatalf("initialize: %s", init["result"])
	}
	r.hub.Message(ch, []byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))

	// The server-initiated GET stream delivers its notification.
	r.waitFrame(func(m map[string]json.RawMessage) bool {
		return strings.Contains(string(m["method"]), "list_changed")
	})
	// The ceiling applies to http servers too.
	if got := toolNames2(t, r.call(ch, 2, "tools/list", `{}`)); fmt.Sprint(got) != "[search]" {
		t.Errorf("tools = %v", got)
	}
	// A call answered as an event stream: the progress notification and the result.
	res := r.call(ch, 3, "tools/call", `{"name":"search"}`)
	if !strings.Contains(string(res["result"]), "found") {
		t.Errorf("call: %s", res)
	}
	ref := r.call(ch, 4, "tools/call", `{"name":"delete_all"}`)
	if !strings.Contains(string(ref["error"]), "-32001") {
		t.Errorf("refused: %s", ref)
	}

	f.mu.Lock()
	ok, headers := f.sessionOK, strings.Join(f.sawHeaders, "|")
	f.mu.Unlock()
	if ok < 3 {
		t.Errorf("only %d requests carried the session and protocol headers", ok)
	}
	if !strings.Contains(headers, "POST v1 ") {
		t.Errorf("the configured header was not sent: %s", headers)
	}

	r.hub.Close(ch)
	r.hub.Shutdown()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.deletes != 1 {
		t.Errorf("the session was not ended: %d DELETEs", f.deletes)
	}
}

func toolNames2(t *testing.T, resp map[string]json.RawMessage) []string {
	t.Helper()
	var res struct {
		Tools []struct{ Name string } `json:"tools"`
	}
	if err := json.Unmarshal(resp["result"], &res); err != nil {
		t.Fatalf("%s", resp)
	}
	var out []string
	for _, x := range res.Tools {
		out = append(out, x.Name)
	}
	return out
}

func TestHTTPErrorBecomesAJSONRPCError(t *testing.T) {
	f := newFakeHTTPServer(t, false)
	r := newRig(t, f.config(""), nil)
	ch := r.open("web")
	f.mu.Lock()
	f.postStatus = 503
	f.mu.Unlock()
	resp := r.call(ch, 1, "tools/list", `{}`)
	if !strings.Contains(string(resp["error"]), "503") || !strings.Contains(string(resp["error"]), "upstream trouble") {
		t.Errorf("resp = %s", resp)
	}
}

func TestHTTPUnreachableIsUnavailable(t *testing.T) {
	f := newFakeHTTPServer(t, false)
	cfg := f.config("")
	f.srv.Close()
	r := newRig(t, cfg, nil)
	_, err := r.hub.Open(t_ctx(t), "web")
	if err == nil || err.Code != "unavailable" || !strings.Contains(err.Message, "cannot reach") {
		t.Fatalf("err = %+v", err)
	}
}

func TestHTTP401NeedsLoginUntilSignedIn(t *testing.T) {
	f := newFakeHTTPServer(t, true)
	r := newRig(t, f.config(""), nil)
	if s := r.hub.List()[0]; s.State != StateReady {
		t.Fatalf("before any contact the server is startable: %+v", s)
	}
	_, oerr := r.hub.Open(t_ctx(t), "web")
	if oerr == nil || oerr.Code != "forbidden" || !strings.Contains(oerr.Message, "galopin connectors login web") {
		t.Fatalf("open: %+v", oerr)
	}
	s := r.hub.List()[0]
	if s.State != StateNeedsLogin || s.Detail == nil || *s.Detail != "Run `galopin connectors login web` on this machine." {
		t.Fatalf("list: %+v", s)
	}

	// Sign in: PKCE, dynamic registration, a loopback redirect.
	var out bytes.Buffer
	err := Login(t_ctx(t), LoginOptions{
		Entry: r.hub.Entry("web"), Store: r.hub.Tokens(), Out: &out,
		OpenBrowser: func(u string) error {
			resp, err := http.Get(u) // the authorize endpoint redirects to the loopback callback
			if err != nil {
				return err
			}
			resp.Body.Close()
			if resp.StatusCode != 200 {
				return fmt.Errorf("callback answered %s", resp.Status)
			}
			return nil
		},
	})
	if err != nil {
		t.Fatalf("login: %v\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), "/authorize?") {
		t.Errorf("the URL was not printed: %s", out.String())
	}
	f.mu.Lock()
	if len(f.registered) != 1 || f.registered[0]["token_endpoint_auth_method"] != "none" {
		t.Errorf("registration = %v", f.registered)
	}
	f.mu.Unlock()
	// 0600 on disk.
	if st, err := osStat(r.dir + "/connectors/web.json"); err != nil || st.Mode().Perm() != 0o600 {
		t.Errorf("token file: %v %v", st, err)
	}

	// The running hub notices the stored sign-in; the server is usable.
	if s := r.hub.List()[0]; s.State != StateReady {
		t.Fatalf("after login: %+v", s)
	}
	ch := r.open("web")
	init := r.call(ch, 1, "initialize", `{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}`)
	if !strings.Contains(string(init["result"]), "httpfake") {
		t.Fatalf("initialize with the token: %s", init)
	}
}

func TestExpiredTokenIsRefreshed(t *testing.T) {
	f := newFakeHTTPServer(t, true)
	r := newRig(t, f.config(""), nil)
	url := f.srv.URL + "/mcp"
	if err := r.hub.Tokens().Save("web", &StoredToken{Server: url, TokenEndpoint: f.srv.URL + "/token", ClientID: "cid-1",
		AccessToken: "stale", RefreshToken: "r1", ExpiresAt: time.Now().Add(-time.Hour).Unix()}); err != nil {
		t.Fatal(err)
	}
	ch := r.open("web")
	init := r.call(ch, 1, "initialize", `{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}`)
	if !strings.Contains(string(init["result"]), "httpfake") {
		t.Fatalf("initialize: %s", init)
	}
	f.mu.Lock()
	n := f.refreshes
	f.mu.Unlock()
	if n < 1 {
		t.Error("the token was not refreshed")
	}
	if got := r.hub.Tokens().Load("web", url); got == nil || got.AccessToken != "good-refreshed" || got.RefreshToken != "r1" {
		t.Errorf("stored = %+v", got)
	}
}

func TestA401MidSessionRefreshesAndRetries(t *testing.T) {
	f := newFakeHTTPServer(t, true)
	r := newRig(t, f.config(""), nil)
	url := f.srv.URL + "/mcp"
	save := func(access string) {
		if err := r.hub.Tokens().Save("web", &StoredToken{Server: url, TokenEndpoint: f.srv.URL + "/token", ClientID: "cid-1",
			AccessToken: access, RefreshToken: "r1", ExpiresAt: time.Now().Add(time.Hour).Unix()}); err != nil {
			t.Fatal(err)
		}
	}
	f.mu.Lock()
	f.goodToken = "v1"
	f.mu.Unlock()
	save("v1")
	ch := r.open("web") // the probe passes
	// The server rotates its token behind galopin's back.
	f.mu.Lock()
	f.goodToken = "rotated"
	f.mu.Unlock()
	init := r.call(ch, 1, "initialize", `{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}`)
	if !strings.Contains(string(init["result"]), "httpfake") {
		t.Fatalf("initialize after a refresh: %s", init)
	}
	f.mu.Lock()
	n := f.refreshes
	f.mu.Unlock()
	if n != 1 {
		t.Errorf("refreshes = %d", n)
	}
}

func TestRevokedStoredTokenNeedsLoginAtOpen(t *testing.T) {
	f := newFakeHTTPServer(t, true)
	r := newRig(t, f.config(""), nil)
	if err := r.hub.Tokens().Save("web", &StoredToken{Server: f.srv.URL + "/mcp", TokenEndpoint: f.srv.URL + "/token", ClientID: "cid-1",
		AccessToken: "revoked", RefreshToken: "r1", ExpiresAt: time.Now().Add(time.Hour).Unix()}); err != nil {
		t.Fatal(err)
	}
	_, oerr := r.hub.Open(t_ctx(t), "web")
	if oerr == nil || oerr.Code != "forbidden" {
		t.Fatalf("open with a revoked token: %+v", oerr)
	}
}

func TestLegacySSETransport(t *testing.T) {
	var mu sync.Mutex
	var stream chan string
	mux := http.NewServeMux()
	mux.HandleFunc("/sse", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		ch := make(chan string, 16)
		mu.Lock()
		stream = ch
		mu.Unlock()
		fmt.Fprint(w, "event: endpoint\ndata: /messages?sid=7\n\n")
		w.(http.Flusher).Flush()
		for {
			select {
			case m := <-ch:
				fmt.Fprintf(w, "event: message\ndata: %s\n\n", m)
				w.(http.Flusher).Flush()
			case <-r.Context().Done():
				return
			}
		}
	})
	mux.HandleFunc("/messages", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var m struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		json.Unmarshal(body, &m)
		w.WriteHeader(202)
		if r.URL.Query().Get("sid") != "7" || len(m.ID) == 0 {
			return
		}
		mu.Lock()
		ch := stream
		mu.Unlock()
		ch <- fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"result":{"via":"sse","method":%q}}`, m.ID, m.Method)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	r := newRig(t, fmt.Sprintf(`{"mcpServers":{"legacy":{"type":"sse","url":%q}}}`, srv.URL+"/sse"), nil)
	ch := r.open("legacy")
	resp := r.call(ch, 1, "tools/list", `{}`)
	if !strings.Contains(string(resp["result"]), `"via":"sse"`) {
		t.Fatalf("resp = %s", resp)
	}
	// The server ending its stream ends the channel.
	srv.CloseClientConnections()
	if c := r.nextClosed(); c.channel != ch || c.reason != "crashed" {
		t.Errorf("closed = %+v", c)
	}
}

// The chat-started sign-in (PROTOCOL.md §10.5): mcp.login answers an
// authorization URL built with Cerea's redirect, the provider sends the browser
// back to Cerea, and mcp.loginComplete exchanges the code on the machine.
func TestLoginFromTheChatAndComplete(t *testing.T) {
	f := newFakeHTTPServer(t, true)
	r := newRig(t, f.config(""), nil)
	var gotCode, gotState string
	cerea := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotCode, gotState = req.URL.Query().Get("code"), req.URL.Query().Get("state")
	}))
	defer cerea.Close()
	redirect := cerea.URL + "/chat/api/v2/local-connectors/oauth/callback"

	authURL, oerr := r.hub.Login(t_ctx(t), "web", redirect)
	if oerr != nil {
		t.Fatalf("login: %+v", oerr)
	}
	if !strings.Contains(authURL, f.srv.URL+"/authorize?") || !strings.Contains(authURL, url.QueryEscape(redirect)) ||
		!strings.Contains(authURL, "code_challenge_method=S256") {
		t.Fatalf("authorization url = %s", authURL)
	}
	f.mu.Lock()
	reg := f.registered[0]["redirect_uris"].([]any)[0]
	f.mu.Unlock()
	if reg != redirect {
		t.Errorf("registered redirect = %v", reg)
	}
	// The browser goes to the provider, which sends it to Cerea.
	resp, err := http.Get(authURL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if gotCode == "" || gotState == "" {
		t.Fatalf("Cerea's callback got code %q state %q", gotCode, gotState)
	}

	// Unknown state, another server's name, an expired state: invalid.
	for name, args := range map[string][3]string{
		"unknown state": {"web", gotCode, "nope"},
		"wrong server":  {"other", gotCode, gotState},
	} {
		if e := r.hub.LoginComplete(t_ctx(t), args[0], args[1], args[2]); e == nil || e.Code != "invalid" {
			t.Errorf("%s: %+v", name, e)
		}
	}
	// (The wrong-server attempt consumed the state: a state is single use.)
	authURL, _ = r.hub.Login(t_ctx(t), "web", redirect)
	resp, _ = http.Get(authURL)
	resp.Body.Close()
	r.hub.mu.Lock()
	for _, p := range r.hub.pending {
		p.Created = time.Now().Add(-11 * time.Minute)
	}
	r.hub.mu.Unlock()
	if e := r.hub.LoginComplete(t_ctx(t), "web", gotCode, gotState); e == nil || e.Code != "invalid" || !strings.Contains(e.Message, "expired") {
		t.Errorf("expired: %+v", e)
	}

	// A good pair stores the tokens and clears needs-login.
	if _, oerr := r.hub.Open(t_ctx(t), "web"); oerr == nil || oerr.Code != "forbidden" {
		t.Fatalf("before sign-in: %+v", oerr)
	}
	authURL, _ = r.hub.Login(t_ctx(t), "web", redirect)
	resp, _ = http.Get(authURL)
	resp.Body.Close()
	if e := r.hub.LoginComplete(t_ctx(t), "web", gotCode, gotState); e != nil {
		t.Fatalf("complete: %+v", e)
	}
	if st, err := osStat(r.dir + "/connectors/web.json"); err != nil || st.Mode().Perm() != 0o600 {
		t.Errorf("token file: %v %v", st, err)
	}
	if s := r.hub.List()[0]; s.State != StateReady {
		t.Errorf("after sign-in: %+v", s)
	}
	ch := r.open("web")
	if init := r.call(ch, 1, "initialize", `{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}`); !strings.Contains(string(init["result"]), "httpfake") {
		t.Errorf("initialize with the stored token: %s", init)
	}
}

func TestLoginErrors(t *testing.T) {
	f := newFakeHTTPServer(t, false) // needs no sign-in
	r := newRig(t, f.config("")[:len(f.config(""))-2]+`,"std":{"command":"x"}}}`, nil)
	for name, c := range map[string]struct{ server, redirect, code string }{
		"unknown":        {"zzz", "http://c/cb", "not_found"},
		"stdio":          {"std", "http://c/cb", "invalid"},
		"no redirect":    {"web", "", "invalid"},
		"needs no login": {"web", "http://c/cb", "invalid"},
	} {
		if _, e := r.hub.Login(t_ctx(t), c.server, c.redirect); e == nil || e.Code != c.code {
			t.Errorf("%s: %+v, want %s", name, e, c.code)
		}
	}
}

func TestLoginCompleteTokenEndpointRefusalIsBackend(t *testing.T) {
	f := newFakeHTTPServer(t, true)
	r := newRig(t, f.config(""), nil)
	authURL, oerr := r.hub.Login(t_ctx(t), "web", "http://127.0.0.1:1/cb")
	if oerr != nil {
		t.Fatal(oerr)
	}
	state := mustQuery(t, authURL, "state")
	// A code the provider never issued: its token endpoint says invalid_grant.
	e := r.hub.LoginComplete(t_ctx(t), "web", "forged", state)
	if e == nil || e.Code != "backend" || !strings.Contains(e.Message, "invalid_grant") {
		t.Errorf("complete: %+v", e)
	}
}

func mustQuery(t *testing.T, raw, key string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u.Query().Get(key)
}
