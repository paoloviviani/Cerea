package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"galopin/internal/attach"
	"galopin/internal/backend"
	backendopencode "galopin/internal/backend/opencode"
	"galopin/internal/policy"
	"galopin/internal/sessions"
	"galopin/internal/workspaces"
)

// testPNG is a real w×h PNG, distinct per shade.
func testPNG(t *testing.T, w, h int, shade uint8) []byte {
	t.Helper()
	img := image.NewGray(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetGray(x, y, color.Gray{Y: shade + uint8((x+y)%16)})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// noisePNG is an incompressible w×h PNG.
func noisePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	rand.New(rand.NewSource(1)).Read(img.Pix)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// TestToolImagesIntegration proves I2 against a real, pinned opencode: a tool
// call that produces an image (opencode's own read tool on a PNG — its
// attachments land in the same state.attachments a browser MCP tool's
// screenshot does) lists the image by sha on the wire tool part with no bytes
// in it, session.attachment returns the bytes, a snapshot (a reload) lists the
// same sha, and an image evicted from galopin's cache is re-read from
// opencode's own transcript. Gated behind GALOPIN_OPENCODE_IT=1.
func TestToolImagesIntegration(t *testing.T) { toolImagesIT(t, 0) }

// TestToolImagesOversizedEventIntegration is the same battery with galopin's
// SSE line limit lowered to 16 MiB, so the nine-screenshot call (~24 MiB in
// one event line) takes the skip-and-resync path for real: the stream must
// stay up and the images must still arrive, through the transcript.
func TestToolImagesOversizedEventIntegration(t *testing.T) { toolImagesIT(t, 16<<20) }

func toolImagesIT(t *testing.T, sseLimit int) {
	if !itEnabled("GALOPIN_OPENCODE_IT", "PYSTINO_AGENT_OPENCODE_IT") {
		t.Skip("set GALOPIN_OPENCODE_IT=1 to run (spawns real opencode + a mock LLM)")
	}
	if _, err := exec.LookPath("opencode"); err != nil {
		t.Skipf("opencode not on PATH: %v", err)
	}

	mockOrigin := startMockLLM(t, itFreePort(t))
	root := t.TempDir()
	dirs := map[string]string{}
	for _, d := range []string{"home", "config", "data", "cache", "workdir", "state"} {
		dirs[d] = filepath.Join(root, d)
		if err := os.MkdirAll(dirs[d], 0o755); err != nil {
			t.Fatal(err)
		}
	}
	workDir := dirs["workdir"]

	shots := map[string][]byte{
		"a.png": testPNG(t, 40, 30, 10),
		// ~1.9 MB of noise: with the nine screenshots it overflows the cache.
		"b.png": noisePNG(t, 700, 700),
	}
	for name, b := range shots {
		if err := os.WriteFile(filepath.Join(workDir, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	mcpImagesPath := filepath.Join(root, "mcp-images.mjs")
	mcpSrc, err := os.ReadFile("internal/backend/opencode/testdata-mcp-images.mjs")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mcpImagesPath, mcpSrc, 0o644); err != nil {
		t.Fatal(err)
	}
	configBody, _ := json.Marshal(map[string]any{
		"$schema": "https://opencode.ai/config.json",
		"provider": map[string]any{"pystino": map[string]any{
			"npm": "@ai-sdk/openai-compatible", "name": "Pystino Mock",
			"options": map[string]any{"baseURL": mockOrigin + "/v1", "apiKey": "test-secret"},
			"models": map[string]any{"mock-model": map[string]any{
				"name": "Mock Model", "limit": map[string]any{"context": 100000, "output": 8000},
			}},
		}},
		"enabled_providers": []string{"pystino"},
		"permission":        map[string]any{"itimg_shots": "allow"},
		"mcp": map[string]any{"itimg": map[string]any{
			"type": "local", "command": []string{"node", mcpImagesPath}, "enabled": true,
		}},
	})
	configPath := filepath.Join(root, "opencode.json")
	if err := os.WriteFile(configPath, configBody, 0o644); err != nil {
		t.Fatal(err)
	}

	// A 17 MiB cache: the nine screenshots nearly fill it, so a later image
	// evicts the first one, which forces the re-read path for real.
	ocBackend := backendopencode.New(backendopencode.Config{
		ConfigPath: configPath,
		Env: []string{
			"HOME=" + dirs["home"], "XDG_CONFIG_HOME=" + dirs["config"], "XDG_DATA_HOME=" + dirs["data"],
			"XDG_CACHE_HOME=" + dirs["cache"], "TMPDIR=" + itTmpDir(t), "PATH=" + os.Getenv("PATH"),
		},
		TmpDir:               filepath.Join(itTmpDir(t), "opencode-tmp"),
		StateDir:             dirs["state"],
		StartupTimeout:       90 * time.Second,
		Logf:                 t.Logf,
		AttachmentCacheBytes: 17 << 20,
		SSEMaxLineBytes:      sseLimit,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := ocBackend.Start(ctx); err != nil {
		t.Fatalf("starting opencode: %v", err)
	}
	t.Cleanup(func() { _ = ocBackend.Stop() })

	pol := policy.Default()
	mat := sessions.New(ocBackend, pol)
	if err := mat.Start(ctx); err != nil {
		t.Fatal(err)
	}
	reg, err := workspaces.Load(filepath.Join(dirs["state"], "workspaces.json"))
	if err != nil {
		t.Fatal(err)
	}
	ws, err := reg.Create("it-ws", workDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	machine := newMachine(reg, ocBackend, mat, pol)
	// One session per image: the mock answers text once any tool result is in
	// a session's history, so a second read needs a fresh history.
	newSession := func(title string) backend.Session {
		sess, err := ocBackend.CreateSession(ctx, workDir, backend.CreateSessionOptions{Title: title})
		if err != nil {
			t.Fatal(err)
		}
		machine.trackSession(ws, sess)
		return sess
	}
	sess := newSession("it-images-a")

	if !ocBackend.Capabilities().ToolImages {
		t.Fatal("toolImages not advertised")
	}

	// readImage prompts a `read` of name and returns the attachments its
	// completed tool part listed.
	readImage := func(t *testing.T, sess backend.Session, name string) []backend.ToolAttachment {
		t.Helper()
		setMockScenario(t, mockOrigin, map[string]any{
			"toolCalls": []map[string]any{{
				"id": "call_" + name, "name": "read",
				"arguments": `{"filePath":"` + filepath.Join(workDir, name) + `"}`,
			}},
			"content": []string{"Looked."}, "finishReason": "stop",
		})
		res, operr := machine.Handle(ctx, "session.prompt", mustJSONArgs(t, map[string]any{"sessionId": sess.ID, "text": "look at " + name}))
		if operr != nil {
			t.Fatalf("prompt: %+v", operr)
		}
		_ = res
		var atts []backend.ToolAttachment
		var wire []byte
		// opencode reports idle more than once per turn: only an idle after
		// this call's completed part ends it.
		completed := false
		events := drainEvents(t, mat, sess.ID, 60*time.Second, func(ev backend.Event) bool {
			if ev.Kind == backend.EventPart && ev.Part != nil && ev.Part.CallID == "call_"+name && ev.Part.ToolStatus == backend.ToolCompleted {
				completed = true
			}
			return completed && isIdle(ev)
		})
		for _, ev := range events {
			if ev.Kind == backend.EventPart && ev.Part != nil && ev.Part.Type == backend.PartTool && ev.Part.CallID == "call_"+name && ev.Part.ToolStatus == backend.ToolCompleted {
				atts = ev.Part.Attachments
				wire, _ = json.Marshal(ev.Part)
			}
		}
		if len(atts) == 0 {
			t.Fatalf("the completed read part listed no attachment; events: %+v", events)
		}
		if bytes.Contains(wire, []byte("data:")) || bytes.Contains(wire, []byte(base64.StdEncoding.EncodeToString(shots[name][:24]))) {
			t.Fatalf("image bytes rode the stream: %.300s", wire)
		}
		return atts
	}

	fetch := func(t *testing.T, sha string) (string, []byte, string) {
		t.Helper()
		res, operr := machine.Handle(ctx, "session.attachment", mustJSONArgs(t, map[string]any{"sessionId": sess.ID, "sha256": sha}))
		if operr != nil {
			return "", nil, operr.Code + ": " + operr.Message
		}
		m := res.(map[string]any)
		data, err := base64.StdEncoding.DecodeString(m["data"].(string))
		if err != nil {
			t.Fatal(err)
		}
		return m["mime"].(string), data, ""
	}

	var shaA, shaB string
	var sessB backend.Session
	t.Run("a tool image is listed by sha and fetched by session.attachment", func(t *testing.T) {
		atts := readImage(t, sess, "a.png")
		if atts[0].SHA256 != attach.Sum(shots["a.png"]) || atts[0].Mime != "image/png" || atts[0].Size != len(shots["a.png"]) {
			t.Fatalf("attachment = %+v, want the sha of the PNG on disk", atts[0])
		}
		shaA = atts[0].SHA256
		mime, data, errMsg := fetch(t, shaA)
		if errMsg != "" || mime != "image/png" || !bytes.Equal(data, shots["a.png"]) {
			t.Fatalf("fetch: mime=%q err=%q equal=%v", mime, errMsg, bytes.Equal(data, shots["a.png"]))
		}
	})

	t.Run("a snapshot (a reload) lists the same sha", func(t *testing.T) {
		res, operr := machine.Handle(ctx, "session.sync", mustJSONArgs(t, map[string]any{"sessionId": sess.ID}))
		if operr != nil {
			t.Fatalf("sync: %+v", operr)
		}
		raw, _ := json.Marshal(res)
		var out struct {
			Snapshot backend.Transcript `json:"snapshot"`
		}
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, e := range out.Snapshot.Messages {
			for _, p := range e.Parts {
				for _, a := range p.Attachments {
					if a.SHA256 == shaA {
						found = true
					}
				}
			}
		}
		if !found {
			t.Fatalf("snapshot lacks the attachment %s: %s", shaA, raw)
		}
		if bytes.Contains(raw, []byte("data:image")) {
			t.Fatal("image bytes in the snapshot")
		}
	})

	// One call, nine ~2 MiB screenshots, ~24 MiB of data: URLs in the tool
	// part's SSE line: past a 16 MiB line limit, so (in the lowered-limit run)
	// the event is skipped and the session resynced; either way the stream
	// must stay up and the images must arrive, capped at 8 with the ninth
	// counted, and be servable.
	t.Run("a call with nine large screenshots keeps the stream up and delivers the images", func(t *testing.T) {
		sessS := newSession("it-images-shots")
		setMockScenario(t, mockOrigin, map[string]any{
			"toolCalls": []map[string]any{{"id": "call_shots", "name": "itimg_shots", "arguments": `{}`}},
			"content":   []string{"Shot."}, "finishReason": "stop",
		})
		if _, operr := machine.Handle(ctx, "session.prompt", mustJSONArgs(t, map[string]any{"sessionId": sessS.ID, "text": "shoot"})); operr != nil {
			t.Fatalf("prompt: %+v", operr)
		}
		var part *backend.Part
		done := false
		drainEvents(t, mat, sessS.ID, 120*time.Second, func(ev backend.Event) bool {
			if ev.Kind == backend.EventPart && ev.Part != nil && ev.Part.CallID == "call_shots" && ev.Part.ToolStatus == backend.ToolCompleted && len(ev.Part.Attachments) > 0 {
				part, done = ev.Part, true
			}
			return done
		})
		// With the lowered limit the part arrives late, through the resync,
		// after the turn's idle: wait for the turn to be over by its status.
		for i := 0; i < 120; i++ {
			if st, _ := mat.Status(sessS.ID); st == backend.StatusIdle {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
		if len(part.Attachments) != 8 || part.AttachmentsOmitted != 1 {
			t.Fatalf("listed %d omitted %d, want 8 and 1", len(part.Attachments), part.AttachmentsOmitted)
		}
		res, operr := machine.Handle(ctx, "session.attachment", mustJSONArgs(t, map[string]any{"sessionId": sessS.ID, "sha256": part.Attachments[3].SHA256}))
		if operr != nil {
			t.Fatalf("fetch: %+v", operr)
		}
		data, _ := base64.StdEncoding.DecodeString(res.(map[string]any)["data"].(string))
		if attach.Sum(data) != part.Attachments[3].SHA256 || len(data) != part.Attachments[3].Size {
			t.Fatal("served bytes do not match the listing")
		}
		// The stream survived: a later ordinary turn still streams to idle.
		setMockScenario(t, mockOrigin, "plainText")
		if _, operr := machine.Handle(ctx, "session.prompt", mustJSONArgs(t, map[string]any{"sessionId": sessS.ID, "text": "still there?"})); operr != nil {
			t.Fatalf("prompt: %+v", operr)
		}
		// opencode reports idle more than once per turn: wait for text first.
		sawText := false
		drainEvents(t, mat, sessS.ID, 60*time.Second, func(ev backend.Event) bool {
			if ev.Kind == backend.EventDelta {
				sawText = true
			}
			return sawText && isIdle(ev)
		})
		if !sawText {
			t.Fatal("no events after the big call: the stream is down")
		}
	})

	t.Run("an evicted image is re-read from opencode's transcript", func(t *testing.T) {
		sessB = newSession("it-images-b")
		shaB = readImage(t, sessB, "b.png")[0].SHA256
		if shaB == shaA {
			t.Fatal("test images must differ")
		}
		mime, data, errMsg := fetch(t, shaA) // evicted by b.png in the tiny cache
		if errMsg != "" || mime != "image/png" || !bytes.Equal(data, shots["a.png"]) {
			t.Fatalf("re-read of the evicted image: mime=%q err=%q", mime, errMsg)
		}
	})

	t.Run("a sha the session never listed is not found", func(t *testing.T) {
		_, _, errMsg := fetch(t, attach.Sum([]byte("never produced")))
		if errMsg == "" {
			t.Fatal("served an unlisted sha")
		}
		// shaB belongs to session B; session A may not read it.
		_, operr := machine.Handle(ctx, "session.attachment", mustJSONArgs(t, map[string]any{"sessionId": sess.ID, "sha256": shaB}))
		if operr == nil || operr.Code != "not_found" {
			t.Fatalf("another session read the image: %+v", operr)
		}
	})
}
