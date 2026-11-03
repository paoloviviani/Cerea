package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"galopin/internal/files"
	"galopin/internal/policy"
)

// writeMachine is filesMachine with an audit log attached, and the
// workspace's directory.
func writeMachine(t *testing.T, pol policy.Policy) (*machine, string, string, string) {
	t.Helper()
	mc, wsID := filesMachine(t, pol)
	w, _ := mc.workspaces.Get(wsID)
	state := t.TempDir()
	audit, err := newAuditLogger(state)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = audit.Close() })
	mc.AttachAudit(audit)
	return mc, wsID, w.Path, filepath.Join(state, "audit.log")
}

func writeArgs(wsID, path, content string, base *string) json.RawMessage {
	body, _ := json.Marshal(map[string]any{
		"workspaceId": wsID, "path": path, "content": content, "encoding": "utf-8", "baseRevision": base,
	})
	return body
}

func revisionOf(t *testing.T, mc *machine, wsID, path string) string {
	t.Helper()
	res, operr := mc.Handle(context.Background(), "files.stat", json.RawMessage(`{"workspaceId":"`+wsID+`","path":"`+path+`"}`))
	if operr != nil {
		t.Fatalf("files.stat: %+v", operr)
	}
	return res.(map[string]any)["entry"].(files.Entry).Revision
}

func TestFilesWriteIsDeniedByDefault(t *testing.T) {
	mc, wsID, dir, auditPath := writeMachine(t, policy.Default())
	base := revisionOf(t, mc, wsID, "main.go")
	_, operr := mc.Handle(context.Background(), "files.write", writeArgs(wsID, "main.go", "package other\n", &base))
	if operr == nil || operr.Code != "forbidden" || !strings.Contains(operr.Message, "--allow-file-write") {
		t.Fatalf("files.write = %+v, want forbidden naming --allow-file-write", operr)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "main.go")); string(got) != "package main\n" {
		t.Errorf("main.go was written: %q", got)
	}
	log, _ := os.ReadFile(auditPath)
	if !strings.Contains(string(log), `"action":"refusal"`) || !strings.Contains(string(log), `"op":"files.write"`) {
		t.Errorf("audit = %s, want the refusal", log)
	}

	pol := policy.Default()
	pol.Files = policy.FilesOff
	pol.FileWrite = policy.FileWriteAllowed
	mc, wsID, _, _ = writeMachine(t, pol)
	if _, operr := mc.Handle(context.Background(), "files.write", writeArgs(wsID, "x.txt", "x", nil)); operr == nil || operr.Code != "forbidden" || !strings.Contains(operr.Message, "--no-files") {
		t.Errorf("files.write with files off = %+v, want forbidden naming --no-files", operr)
	}
}

func TestFilesWriteSavesAndAuditsWithoutContent(t *testing.T) {
	pol := policy.Default()
	pol.FileWrite = policy.FileWriteAllowed
	mc, wsID, dir, auditPath := writeMachine(t, pol)
	ctx := context.Background()

	base := revisionOf(t, mc, wsID, "main.go")
	res, operr := mc.Handle(ctx, "files.write", writeArgs(wsID, "main.go", "package saved // SENTINEL\n", &base))
	if operr != nil {
		t.Fatalf("files.write: %+v", operr)
	}
	entry := res.(map[string]any)["entry"].(files.Entry)
	if entry.Path != "main.go" || entry.Revision == base || entry.Revision == "" {
		t.Errorf("entry = %+v", entry)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "main.go")); string(got) != "package saved // SENTINEL\n" {
		t.Errorf("main.go = %q", got)
	}

	// The revision is stale now: a conflict carrying the one on disk.
	_, operr = mc.Handle(ctx, "files.write", writeArgs(wsID, "main.go", "package stale\n", &base))
	if operr == nil || operr.Code != "conflict" {
		t.Fatalf("stale write = %+v, want conflict", operr)
	}
	details, _ := json.Marshal(operr.Details)
	if string(details) != `{"revision":"`+entry.Revision+`"}` {
		t.Errorf("conflict details = %s, want the revision on disk (%s)", details, entry.Revision)
	}
	// Create-only on a file that exists: a conflict too.
	if _, operr := mc.Handle(ctx, "files.write", writeArgs(wsID, "main.go", "x", nil)); operr == nil || operr.Code != "conflict" {
		t.Errorf("create over an existing file = %+v, want conflict", operr)
	}
	// The deny list holds for writes as for reads.
	if _, operr := mc.Handle(ctx, "files.write", writeArgs(wsID, "id_rsa", "x", nil)); operr == nil || operr.Code != "forbidden" {
		t.Errorf("writing id_rsa = %+v, want forbidden", operr)
	}
	if _, operr := mc.Handle(ctx, "files.write", writeArgs(wsID, "../escape.txt", "x", nil)); operr == nil || operr.Code != "invalid" {
		t.Errorf("writing ../escape.txt = %+v, want invalid", operr)
	}
	big := strings.Repeat("a", files.MaxWriteBytes+1)
	if _, operr := mc.Handle(ctx, "files.write", writeArgs(wsID, "big.txt", big, nil)); operr == nil || operr.Code != "too_large" {
		t.Errorf("writing 1 MiB + 1 = %+v, want too_large", operr)
	}
	if _, operr := mc.Handle(ctx, "files.write", json.RawMessage(`{"workspaceId":"`+wsID+`","path":"a.txt","baseRevision":null}`)); operr == nil || operr.Code != "invalid" {
		t.Errorf("no content = %+v, want invalid", operr)
	}

	log, err := os.ReadFile(auditPath)
	if err != nil {
		t.Fatal(err)
	}
	var lines []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(log)), "\n") {
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("audit line %q: %v", line, err)
		}
		if entry["action"] == "files.write" {
			lines = append(lines, entry)
		}
	}
	var got []string
	for _, l := range lines {
		got = append(got, l["path"].(string)+":"+l["outcome"].(string))
	}
	want := []string{"main.go:ok", "main.go:conflict", "main.go:conflict", "id_rsa:forbidden", "../escape.txt:invalid", "big.txt:too_large"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("audited writes = %v, want %v", got, want)
	}
	if lines[0]["bytes"] != float64(len("package saved // SENTINEL\n")) || lines[0]["workspace"] != wsID {
		t.Errorf("first audit line = %v", lines[0])
	}
	if strings.Contains(string(log), "SENTINEL") || strings.Contains(string(log), "package") {
		t.Errorf("the audit log carries file content: %s", log)
	}
}
