package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"galopin/internal/backend"
	backendopencode "galopin/internal/backend/opencode"
	"galopin/internal/policy"
	"galopin/internal/sessions"
	"galopin/internal/workspaces"
)

// TestHistoryPagingIntegration proves the history-paging ops against a real,
// pinned opencode: session.sync honours a limit (the newest page, with
// hasMore/before; none of it without one), session.history pages strictly
// older messages in ascending order with the same per-message mapping, the
// pages chained to the top reassemble the whole transcript with no gaps or
// duplicates, a tool call and its result travel inside one message (they are
// parts of one message, so no page can split them), and older pages carry no
// live state. Gated behind GALOPIN_OPENCODE_IT=1.
func TestHistoryPagingIntegration(t *testing.T) {
	if !itEnabled("GALOPIN_OPENCODE_IT", "PYSTINO_AGENT_OPENCODE_IT") {
		t.Skip("set GALOPIN_OPENCODE_IT=1 to run (spawns real opencode + a mock LLM)")
	}
	if _, err := exec.LookPath("opencode"); err != nil {
		t.Skipf("opencode not on PATH: %v", err)
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skipf("node not on PATH: %v", err)
	}

	mockPort := itFreePort(t)
	mockOrigin := startMockLLM(t, mockPort)

	root := t.TempDir()
	homeDir := filepath.Join(root, "home")
	configDir := filepath.Join(root, "config")
	dataDir := filepath.Join(root, "data")
	cacheDir := filepath.Join(root, "cache")
	workDir := filepath.Join(root, "workdir")
	for _, d := range []string{homeDir, configDir, dataDir, cacheDir, workDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(workDir, "out.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	opencodeConfig := map[string]any{
		"$schema": "https://opencode.ai/config.json",
		"provider": map[string]any{
			"pystino": map[string]any{
				"npm":  "@ai-sdk/openai-compatible",
				"name": "Pystino Mock",
				"options": map[string]any{
					"baseURL": mockOrigin + "/v1",
					"apiKey":  "test-secret",
				},
				"models": map[string]any{
					"mock-model": map[string]any{
						"name":  "Mock Model",
						"limit": map[string]any{"context": 100000, "output": 8000},
					},
				},
			},
		},
		"enabled_providers": []string{"pystino"},
		"permission":        map[string]any{"bash": "ask"},
	}
	configBody, err := json.MarshalIndent(opencodeConfig, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(root, "opencode.json")
	if err := os.WriteFile(configPath, configBody, 0o644); err != nil {
		t.Fatal(err)
	}

	ocBackend := backendopencode.New(backendopencode.Config{
		ConfigPath: configPath,
		Env: []string{
			"HOME=" + homeDir, "XDG_CONFIG_HOME=" + configDir, "XDG_DATA_HOME=" + dataDir,
			"XDG_CACHE_HOME=" + cacheDir, "TMPDIR=" + itTmpDir(t), "PATH=" + os.Getenv("PATH"),
		},
		TmpDir:         filepath.Join(itTmpDir(t), "opencode-tmp"),
		StartupTimeout: 90 * time.Second,
		Logf:           t.Logf,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := ocBackend.Start(ctx); err != nil {
		t.Fatalf("starting opencode: %v", err)
	}
	t.Cleanup(func() {
		if err := ocBackend.Stop(); err != nil {
			t.Logf("stopping opencode: %v", err)
		}
	})

	pol := policy.Default()
	mat := sessions.New(ocBackend, pol)
	if err := mat.Start(ctx); err != nil {
		t.Fatal(err)
	}
	reg, err := workspaces.Load(filepath.Join(root, "workspaces.json"))
	if err != nil {
		t.Fatal(err)
	}
	ws, err := reg.Create("it-ws", workDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	machine := newMachine(reg, ocBackend, mat, pol)

	sess, err := ocBackend.CreateSession(ctx, workDir, backend.CreateSessionOptions{Title: "it-paging"})
	if err != nil {
		t.Fatalf("creating session: %v", err)
	}
	machine.trackSession(ws, sess)

	// Eight turns: plain answers, with the fifth answered by a `read` tool
	// call and then text — the tool-call message the boundary checks look at.
	// Settle waits for an idle that comes AFTER the turn did something: a
	// stale idle from the previous turn can still sit in the event channel
	// when the next drain starts, and stopping on it fires the next prompt
	// under the previous turn's scenario.
	settle := func(i int) {
		t.Helper()
		active := false
		drainEvents(t, mat, sess.ID, 60*time.Second, func(ev backend.Event) bool {
			if ev.Kind != backend.EventStatus {
				active = true
			}
			return active && isIdle(ev)
		})
		_ = i
	}
	for i := 1; i <= 8; i++ {
		if i == 5 {
			setMockScenario(t, mockOrigin, map[string]any{
				"toolCalls": []map[string]any{{
					"id": "call_read_5", "name": "read",
					"arguments": `{"filePath":"` + filepath.Join(workDir, "out.txt") + `"}`,
				}},
				"content": []string{"Read it."}, "finishReason": "stop",
			})
		} else {
			setMockScenario(t, mockOrigin, "plainText")
		}
		if _, operr := machine.Handle(ctx, "session.prompt", mustJSONArgs(t, map[string]any{
			"sessionId": sess.ID, "text": "turn " + itoaForIT(i),
		})); operr != nil {
			t.Fatalf("prompt %d: %+v", i, operr)
		}
		settle(i)
	}

	sync := func(t *testing.T, args map[string]any) map[string]any {
		t.Helper()
		res, operr := machine.Handle(ctx, "session.sync", mustJSONArgs(t, args))
		if operr != nil {
			t.Fatalf("session.sync %v: %+v", args, operr)
		}
		raw, err := json.Marshal(res)
		if err != nil {
			t.Fatal(err)
		}
		var out map[string]any
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	// fullIDs reads a session.sync ANSWER (epoch/seq/snapshot) and returns
	// its snapshot's message ids, oldest first.
	fullIDs := func(t *testing.T, out map[string]any) []string {
		snap, ok := out["snapshot"].(map[string]any)
		if !ok {
			b, _ := json.Marshal(out)
			t.Fatalf("sync answer carries no snapshot: %s", b)
		}
		rawList, ok := snap["messages"].([]any)
		if !ok {
			b, _ := json.Marshal(out)
			t.Fatalf("snapshot carries no messages array: %s", b)
		}
		var ids []string
		for _, m := range rawList {
			ids = append(ids, m.(map[string]any)["message"].(map[string]any)["id"].(string))
		}
		return ids
	}

	// historyIDs reads a session.history answer's message ids, oldest first.
	historyIDs := func(t *testing.T, res map[string]any) []string {
		rawList, ok := res["messages"].([]any)
		if !ok {
			b, _ := json.Marshal(res)
			t.Fatalf("session.history answer carries no messages array: %s", b)
		}
		var ids []string
		for _, m := range rawList {
			ids = append(ids, m.(map[string]any)["message"].(map[string]any)["id"].(string))
		}
		return ids
	}

	history := func(t *testing.T, args map[string]any) (map[string]any, *[]byte) {
		t.Helper()
		res, operr := machine.Handle(ctx, "session.history", mustJSONArgs(t, args))
		if operr != nil {
			t.Fatalf("session.history %v: %+v", args, operr)
		}
		raw, err := json.Marshal(res)
		if err != nil {
			t.Fatal(err)
		}
		var out map[string]any
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		return out, &raw
	}

	t.Run("an unlimited sync is the whole transcript with no paging fields", func(t *testing.T) {
		out := sync(t, map[string]any{"sessionId": sess.ID})
		if _, ok := out["snapshot"].(map[string]any)["hasMore"]; ok {
			t.Fatalf("unlimited snapshot carries hasMore: %s", out["snapshot"])
		}
		if n := len(fullIDs(t, out)); n < 16 {
			t.Fatalf("eight turns should have seeded at least 16 messages, got %d", n)
		}
	})

	t.Run("a limited sync holds the newest page with hasMore and before", func(t *testing.T) {
		whole := fullIDs(t, sync(t, map[string]any{"sessionId": sess.ID}))
		out := sync(t, map[string]any{"sessionId": sess.ID, "limit": 5})
		snap := out["snapshot"].(map[string]any)
		ids := fullIDs(t, out)
		if len(ids) != 5 {
			t.Fatalf("limited snapshot holds %d messages, want 5", len(ids))
		}
		tail := whole[len(whole)-5:]
		for i := range tail {
			if ids[i] != tail[i] {
				t.Fatalf("page[%d] = %s, want %s (the newest five, in order)", i, ids[i], tail[i])
			}
		}
		if snap["hasMore"] != true {
			t.Fatalf("hasMore = %v, want true", snap["hasMore"])
		}
		if snap["before"] != ids[0] {
			t.Fatalf("before = %v, want %s (the page's oldest)", snap["before"], ids[0])
		}
	})

	t.Run("history pages chain back to the start of the session", func(t *testing.T) {
		whole := fullIDs(t, sync(t, map[string]any{"sessionId": sess.ID}))
		out := sync(t, map[string]any{"sessionId": sess.ID, "limit": 5})
		snap := out["snapshot"].(map[string]any)
		before := snap["before"].(string)
		firstPage := fullIDs(t, out)

		var pagedPages [][]string
		pages := 0
		for {
			res, raw := history(t, map[string]any{"sessionId": sess.ID, "before": before, "limit": 5})
			pages++
			// The op's answer carries the page and nothing else: no
			// permissions, questions, status or usage — live state no
			// older page holds. Key names, not a substring scan: a tool
			// part's own status field is not the transcript's.
			var keys map[string]any
			if err := json.Unmarshal(*raw, &keys); err != nil {
				t.Fatalf("session.history answer: %v", err)
			}
			for _, key := range []string{"permissions", "questions", "status", "usage"} {
				if _, present := keys[key]; present {
					t.Fatalf("session.history answer carries %s: %s", key, *raw)
				}
			}
			ids := historyIDs(t, res)
			for i := 1; i < len(ids); i++ {
				if ids[i-1] == ids[i] {
					t.Fatalf("a page repeated %s", ids[i])
				}
			}
			// Pages arrive oldest-last (each is older than the one before
			// it); the walk below reverses them into chronological order.
			pagedPages = append(pagedPages, ids)
			if res["hasMore"] != true {
				if pageBefore, _ := res["before"].(string); pageBefore != "" && len(ids) > 0 && pageBefore != ids[0] {
					t.Fatalf("before = %s, want the page's oldest %s", pageBefore, ids[0])
				}
				break
			}
			next, ok := res["before"].(string)
			if !ok || next == "" || next == before {
				t.Fatalf("hasMore without a fresh before: %s", res)
			}
			before = next
			if pages > 20 {
				t.Fatal("paging never reached the start")
			}
		}
		paged := []string{}
		for i := len(pagedPages) - 1; i >= 0; i-- {
			paged = append(paged, pagedPages[i]...)
		}
		if len(paged)+len(firstPage) != len(whole) {
			t.Fatalf("pages (%d) plus the first page (%d) do not reassemble the whole (%d)",
				len(paged), len(firstPage), len(whole))
		}
		// Oldest first everywhere: the paged run is the whole transcript,
		// in order, with no gap and no duplicate.
		all := append(append([]string{}, paged...), firstPage...)
		for i := range all {
			if all[i] != whole[i] {
				t.Fatalf("reassembled[%d] = %s, want %s", i, all[i], whole[i])
			}
		}
	})

	t.Run("a tool call and its result never leave their message", func(t *testing.T) {
		syncAll := sync(t, map[string]any{"sessionId": sess.ID})
		messages := syncAll["snapshot"].(map[string]any)["messages"].([]any)
		toolPages := map[string]bool{}
		for _, m := range messages {
			entry := m.(map[string]any)
			for _, p := range entry["parts"].([]any) {
				part := p.(map[string]any)
				if part["type"] != "tool" {
					continue
				}
				// A completed tool part carries the call and its result on
				// the same object — paging at message boundaries can only
				// ever move the whole message.
				if part["status"] == "completed" {
					if _, ok := part["input"].(map[string]any); !ok {
						t.Fatalf("completed tool part without input: %s", part)
					}
					if _, ok := part["output"]; !ok {
						t.Fatalf("completed tool part without output: %s", part)
					}
				}
				toolPages[entry["message"].(map[string]any)["id"].(string)] = true
			}
		}
		if len(toolPages) == 0 {
			t.Fatal("the transcript has no tool message to check the boundary with")
		}
		// And every page that contains one carries the whole message: walk
		// the pages again and assert each tool message appears exactly once,
		// whole, wherever the boundary put it.
		seen := map[string]int{}
		out := sync(t, map[string]any{"sessionId": sess.ID, "limit": 4})
		before, _ := out["snapshot"].(map[string]any)["before"].(string)
		for {
			res, _ := history(t, map[string]any{"sessionId": sess.ID, "before": before, "limit": 4})
			for _, m := range res["messages"].([]any) {
				id := m.(map[string]any)["message"].(map[string]any)["id"].(string)
				seen[id]++
			}
			if next, _ := res["before"].(string); res["hasMore"] != true || next == "" {
				break
			} else {
				before = next
			}
		}
		for id := range toolPages {
			if seen[id] != 0 && seen[id] != 1 {
				t.Fatalf("tool message %s appeared in %d pages", id, seen[id])
			}
		}
	})

	t.Run("history validates its args", func(t *testing.T) {
		for name, args := range map[string]map[string]any{
			"zero limit": {"sessionId": sess.ID, "before": "msg_x", "limit": 0},
			"no before":  {"sessionId": sess.ID, "limit": 5},
		} {
			_, operr := machine.Handle(ctx, "session.history", mustJSONArgs(t, args))
			if operr == nil || operr.Code != "invalid" {
				t.Fatalf("%s: operr = %+v, want invalid", name, operr)
			}
		}
	})
}

func itoaForIT(i int) string {
	b, _ := json.Marshal(i)
	return string(b)
}
