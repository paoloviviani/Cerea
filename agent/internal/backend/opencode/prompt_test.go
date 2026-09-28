package opencode

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"galopin/internal/backend"
)

// promptFake answers the endpoints the prompt-path tests touch, recording
// the last prompt_async body. messageIDBehaviour decides what the server
// does with the caller-minted id, which is exactly the fork in behaviour
// the mapping has two paths for:
//
//   - honour: the id is echoed back as the user message on GET /message —
//     what opencode 1.18.32 does (plan §1.2 probed session.command's
//     identical field live; §3.6 found the field on prompt_async too).
//   - rewrite: the server invents its own id and the minted one never
//     appears — the fallback (next new user message) path.
func promptFake(t *testing.T, honour bool) (*Backend, *map[string]any) {
	t.Helper()
	var lastPrompt map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/prompt_async"):
			body, _ := io.ReadAll(r.Body)
			lastPrompt = nil
			_ = json.Unmarshal(body, &lastPrompt)
			w.WriteHeader(http.StatusNoContent)
		case strings.HasSuffix(r.URL.Path, "/message"):
			id := "msg_serverwrote0000000000000000aa"
			if honour {
				id, _ = lastPrompt["messageID"].(string)
			}
			_, _ = io.WriteString(w, `[{"info":{"id":"`+id+`","role":"user"},"parts":[]}]`)
		case r.URL.Path == "/session/ses_1":
			_, _ = io.WriteString(w, `{"id":"ses_1","title":"t"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	port, _ := strconv.Atoi(portStr)
	return New(Config{Hostname: host, Port: port, Password: "x"}), &lastPrompt
}

// TestPromptSendsAMintedAscendingMessageID pins the minted id's wire shape:
// present as exactly the messageID field, opencode-shaped ("msg_" + 26
// chars: 12 hex of (millis*0x1000+counter), then 14 base62), and ascending
// across successive prompts.
func TestPromptSendsAMintedAscendingMessageID(t *testing.T) {
	b, last := promptFake(t, true)
	ctx := context.Background()

	first := ""
	for i := 0; i < 2; i++ {
		if err := b.Prompt(ctx, "/ws", "ses_1", backend.Prompt{Text: "go"}); err != nil {
			t.Fatal(err)
		}
		id, _ := (*last)["messageID"].(string)
		if id == "" {
			t.Fatalf("prompt body = %v, want a messageID field", *last)
		}
		if !strings.HasPrefix(id, "msg_") || len(id) != len("msg_")+26 {
			t.Fatalf("messageID = %q, want msg_ + 26 characters", id)
		}
		hex := id[len("msg_") : len("msg_")+12]
		encoded, err := strconv.ParseUint(hex, 16, 64)
		if err != nil {
			t.Fatalf("messageID hex prefix %q is not hex: %v", hex, err)
		}
		// opencode keeps only the low 48 bits, so the decoded timestamp is
		// the wall clock modulo 2^36 ms (its own Identifier.timestamp does
		// the same arithmetic).
		if diff := (encoded/0x1000 - uint64(time.Now().UnixMilli()%(1<<36)) + (1 << 36)) % (1 << 36); diff > 5 && diff < (1<<36)-5 {
			t.Errorf("messageID timestamp = %d, want roughly now", encoded/0x1000)
		}
		if first != "" && id <= first {
			t.Errorf("second minted messageID %q must sort after the first %q", id, first)
		}
		first = id
	}
}

// TestPromptMapsClientMessageIDExactlyWhenTheServerHonoursTheID runs the
// primary path: the server keeps the minted id, so the clientMessageId is
// resolved by exact map lookup — and the fallback claim is spent at that
// moment rather than lingering to mis-tag some later user message.
func TestPromptMapsClientMessageIDExactlyWhenTheServerHonoursTheID(t *testing.T) {
	b, _ := promptFake(t, true)
	ctx := context.Background()

	if err := b.Prompt(ctx, "/ws", "ses_1", backend.Prompt{Text: "go", ClientMessageID: "cm-exact"}); err != nil {
		t.Fatal(err)
	}

	tr, err := b.Transcript(ctx, "/ws", "ses_1")
	if err != nil {
		t.Fatal(err)
	}
	if len(tr.Messages) != 1 || tr.Messages[0].Message.Role != "user" {
		t.Fatalf("transcript = %+v, want one user message", tr.Messages)
	}
	if got := tr.Messages[0].Message.ClientMessageID; got != "cm-exact" {
		t.Fatalf("ClientMessageID = %q, want cm-exact (the exact mapping won)", got)
	}

	// The fallback must be spent: a later user message the server created
	// on its own (no prompt of ours claimed it) gets nothing.
	tr, err = b.Transcript(ctx, "/ws", "ses_1")
	if err != nil {
		t.Fatal(err)
	}
	if got := tr.Messages[0].Message.ClientMessageID; got != "cm-exact" {
		t.Fatalf("re-read ClientMessageID = %q, want cm-exact still", got)
	}
	b.pendingMu.Lock()
	_, pendingLeft := b.pendingClientMsg["ses_1"]
	b.pendingMu.Unlock()
	if pendingLeft {
		t.Error("the fallback claim survived the exact mapping resolving; it would mis-tag the next user message")
	}
}

// TestPromptFallsBackToTheNextMessageWhenTheServerRewritesTheID documents
// the fallback: with a server that invents its own id, the minted id never
// appears, and the clientMessageId lands on the next new user message —
// exactly what the pre-minting code always did.
func TestPromptFallsBackToTheNextMessageWhenTheServerRewritesTheID(t *testing.T) {
	b, _ := promptFake(t, false)
	ctx := context.Background()

	if err := b.Prompt(ctx, "/ws", "ses_1", backend.Prompt{Text: "go", ClientMessageID: "cm-fallback"}); err != nil {
		t.Fatal(err)
	}

	tr, err := b.Transcript(ctx, "/ws", "ses_1")
	if err != nil {
		t.Fatal(err)
	}
	if len(tr.Messages) != 1 {
		t.Fatalf("transcript = %+v, want one message", tr.Messages)
	}
	if got := tr.Messages[0].Message.ClientMessageID; got != "cm-fallback" {
		t.Fatalf("ClientMessageID = %q, want cm-fallback via the next-user-message fallback", got)
	}
}

// TestPromptMintsEvenWithoutAClientMessageID: the minted id rides on every
// prompt (batch A's session.command reuses the helper), with no mapping
// recorded when there is nothing to map.
func TestPromptMintsEvenWithoutAClientMessageID(t *testing.T) {
	b, last := promptFake(t, true)
	ctx := context.Background()

	if err := b.Prompt(ctx, "/ws", "ses_1", backend.Prompt{Text: "go"}); err != nil {
		t.Fatal(err)
	}
	if _, ok := (*last)["messageID"]; !ok {
		t.Fatalf("prompt body = %v, want a messageID even with no clientMessageId", *last)
	}
	tr, err := b.Transcript(ctx, "/ws", "ses_1")
	if err != nil {
		t.Fatal(err)
	}
	if got := tr.Messages[0].Message.ClientMessageID; got != "" {
		t.Fatalf("ClientMessageID = %q, want empty (nothing was claimed)", got)
	}
}
