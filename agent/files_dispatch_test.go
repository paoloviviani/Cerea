package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"galopin/internal/policy"
	"galopin/internal/sessions"
	"galopin/internal/workspaces"
)

func filesMachine(t *testing.T, pol policy.Policy) (*machine, string) {
	t.Helper()
	reg, err := workspaces.Load(filepath.Join(t.TempDir(), "workspaces.json"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	for name, body := range map[string]string{"main.go": "package main\n", ".env": "SECRET=1\n"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	w, err := reg.Create("ws", dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	back := &fakeBackend{}
	return newMachine(reg, back, sessions.New(back, pol), pol), w.ID
}

func TestFilesOpsServeTheWorkspaceAndRedact(t *testing.T) {
	mc, wsID := filesMachine(t, policy.Default())
	ctx := context.Background()

	res, operr := mc.Handle(ctx, "files.list", json.RawMessage(`{"workspaceId":"`+wsID+`"}`))
	if operr != nil {
		t.Fatalf("files.list: %+v", operr)
	}
	raw, _ := json.Marshal(res)
	if !strings.Contains(string(raw), `"name":"main.go"`) || !strings.Contains(string(raw), `"name":".env","path":".env"`) {
		t.Fatalf("list = %s", raw)
	}
	if !strings.Contains(string(raw), `"redacted":true`) {
		t.Errorf("list = %s, want .env redacted", raw)
	}

	read, operr := mc.Handle(ctx, "files.read", json.RawMessage(`{"workspaceId":"`+wsID+`","path":"main.go"}`))
	if operr != nil {
		t.Fatalf("files.read: %+v", operr)
	}
	if b, _ := json.Marshal(read); !strings.Contains(string(b), `package main`) {
		t.Errorf("read = %s", b)
	}
	if _, operr := mc.Handle(ctx, "files.read", json.RawMessage(`{"workspaceId":"`+wsID+`","path":".env"}`)); operr == nil || operr.Code != "forbidden" {
		t.Errorf("reading .env = %+v, want forbidden", operr)
	}
	if _, operr := mc.Handle(ctx, "files.read", json.RawMessage(`{"workspaceId":"`+wsID+`","path":"../x"}`)); operr == nil || operr.Code != "invalid" {
		t.Errorf("reading ../x = %+v, want invalid", operr)
	}
	if _, operr := mc.Handle(ctx, "files.list", json.RawMessage(`{"workspaceId":"nope"}`)); operr == nil || operr.Code != "not_found" {
		t.Errorf("unknown workspace = %+v, want not_found", operr)
	}
}

func TestFilesOpsRefusedWithNoFiles(t *testing.T) {
	pol := policy.Default()
	pol.Files = policy.FilesOff
	mc, wsID := filesMachine(t, pol)
	for _, op := range []string{"files.list", "files.stat", "files.read", "files.status"} {
		_, operr := mc.Handle(context.Background(), op, json.RawMessage(`{"workspaceId":"`+wsID+`","path":"main.go"}`))
		if operr == nil || operr.Code != "forbidden" || !strings.Contains(operr.Message, "--no-files") {
			t.Errorf("%s = %+v, want forbidden naming --no-files", op, operr)
		}
	}
}

func TestEffectiveFileDeny(t *testing.T) {
	p := policy.Default()
	if got := p.EffectiveFileDeny(); len(got) != len(policy.DefaultFileDeny) {
		t.Errorf("default deny = %v", got)
	}
	p.FileDeny = []string{"*.secret"}
	if got := p.EffectiveFileDeny(); got[len(got)-1] != "*.secret" {
		t.Errorf("added deny = %v", got)
	}
	p.NoDefaultFileDeny = true
	if got := p.EffectiveFileDeny(); len(got) != 1 || got[0] != "*.secret" {
		t.Errorf("without defaults = %v", got)
	}
}
