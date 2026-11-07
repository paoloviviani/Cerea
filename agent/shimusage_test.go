package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// usageShim is a shim in front of a gateway that answers `reply` and records
// the request body it was sent.
func usageShim(t *testing.T, contentType, reply string) (*shim, *string, *[]usageSample) {
	t.Helper()
	var sent string
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		sent = string(b)
		w.Header().Set("Content-Type", contentType)
		_, _ = io.WriteString(w, reply)
	}))
	t.Cleanup(gw.Close)
	creds := &credentials{Gateway: gw.URL + "/v1", AccessToken: "tok", RefreshToken: "r", ExpiresIn: 3600, ObtainedAt: time.Now().Unix()}
	path := filepath.Join(t.TempDir(), "creds.json")
	if err := saveCredentials(path, creds); err != nil {
		t.Fatal(err)
	}
	s := newShim(creds, path, statusPathFor(path), 41872)
	s.setSessionTag(func(string) string { return "root" })
	var got []usageSample
	s.setUsageSink(func(session string, u usageSample) {
		if session != "root" {
			t.Errorf("usage attributed to %q, want root", session)
		}
		got = append(got, u)
	})
	return s, &sent, &got
}

func chat(s *shim, body string) string {
	rec := httptest.NewRecorder()
	s.handler(rec, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body)))
	return rec.Body.String()
}

const plainReply = `{"model":"m-up","choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":60},"completion_tokens_details":{"reasoning_tokens":5}}}`

func TestUsageNonStreaming(t *testing.T) {
	s, sent, got := usageShim(t, "application/json", plainReply)
	out := chat(s, `{"model":"m","messages":[]}`)
	if out != plainReply {
		t.Errorf("response changed: %s", out)
	}
	if strings.Contains(*sent, "stream_options") {
		t.Errorf("a non-streamed request was given stream_options: %s", *sent)
	}
	if len(*got) != 1 || (*got)[0] != (usageSample{Model: "m", PromptTokens: 100, CompletionTokens: 20, CachedTokens: 60, ReasoningTokens: 5}) {
		t.Errorf("usage = %+v", *got)
	}
}

func streamReply(withUsageChunk bool) string {
	r := "data: {\"model\":\"m-up\",\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n" +
		"data: {\"model\":\"m-up\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
	if withUsageChunk {
		r += "data: {\"model\":\"m-up\",\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":3}}\n\n"
	}
	return r + "data: [DONE]\n\n"
}

func TestUsageStreamingWithoutIncludeUsageAsksForItAndHidesTheChunk(t *testing.T) {
	s, sent, got := usageShim(t, "text/event-stream", streamReply(true))
	out := chat(s, `{"model":"m","stream":true,"messages":[]}`)
	var req struct {
		StreamOptions struct {
			IncludeUsage bool `json:"include_usage"`
		} `json:"stream_options"`
	}
	if err := json.Unmarshal([]byte(*sent), &req); err != nil || !req.StreamOptions.IncludeUsage {
		t.Errorf("upstream request lacks include_usage: %s", *sent)
	}
	if out != streamReply(false) {
		t.Errorf("the client saw:\n%s\nwant the stream without the usage chunk:\n%s", out, streamReply(false))
	}
	if len(*got) != 1 || (*got)[0].PromptTokens != 10 || (*got)[0].CompletionTokens != 3 || (*got)[0].Model != "m" {
		t.Errorf("usage = %+v", *got)
	}
}

func TestUsageStreamingWithIncludeUsageKeepsTheChunk(t *testing.T) {
	s, sent, got := usageShim(t, "text/event-stream", streamReply(true))
	out := chat(s, `{"model":"m","stream":true,"stream_options":{"include_usage":true,"other":1},"messages":[]}`)
	if !strings.Contains(*sent, `"other":1`) {
		t.Errorf("the client's stream_options were rewritten: %s", *sent)
	}
	if out != streamReply(true) {
		t.Errorf("the client asked for usage and did not get it:\n%s", out)
	}
	if len(*got) != 1 {
		t.Errorf("usage = %+v", *got)
	}
}

func TestUsageStreamingKeepsOtherStreamOptions(t *testing.T) {
	s, sent, _ := usageShim(t, "text/event-stream", streamReply(true))
	chat(s, `{"model":"m","stream":true,"stream_options":{"other":1},"messages":[]}`)
	if !strings.Contains(*sent, `"other":1`) || !strings.Contains(*sent, `"include_usage":true`) {
		t.Errorf("merge lost something: %s", *sent)
	}
}

func TestUsageNothingReportedWithoutATagOrAUsage(t *testing.T) {
	s, _, got := usageShim(t, "application/json", `{"choices":[]}`)
	chat(s, `{"model":"m"}`)
	s.setSessionTag(func(string) string { return "" })
	s2, _, got2 := usageShim(t, "application/json", plainReply)
	s2.setSessionTag(func(string) string { return "" })
	chat(s2, `{"model":"m"}`)
	if len(*got)+len(*got2) != 0 {
		t.Errorf("usage reported: %+v %+v", *got, *got2)
	}
}

func TestUsageFromSampleMatchesOpencodeShape(t *testing.T) {
	u := usageFromSample(usageSample{PromptTokens: 100, CompletionTokens: 20, CachedTokens: 60, ReasoningTokens: 5}, 1000)
	if u.Input != 40 || u.CacheRead != 60 || u.Output != 15 || u.Reasoning != 5 || u.ContextUsed != 120 || u.Cost != 0 {
		t.Errorf("usage = %+v", u)
	}
	if u.ContextMax == nil || *u.ContextMax != 1000 {
		t.Errorf("ContextMax = %v", u.ContextMax)
	}
	if usageFromSample(usageSample{PromptTokens: 1}, 0).ContextMax != nil {
		t.Error("an unknown window must stay unknown")
	}
}
