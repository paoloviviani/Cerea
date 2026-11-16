package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"galopin/internal/files"
	"galopin/internal/link"
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
	if operr == nil || operr.Code != "forbidden" || !strings.Contains(operr.Message, "policy set --allow-file-write") {
		t.Fatalf("files.write = %+v, want forbidden naming policy set --allow-file-write", operr)
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

func callOp(t *testing.T, mc *machine, op string, args map[string]any) (any, *link.OpError) {
	t.Helper()
	raw, _ := json.Marshal(args)
	return mc.Handle(context.Background(), op, raw)
}

func TestFilesUploadOps(t *testing.T) {
	mc, wsID, dir, auditPath := writeMachine(t, freshEnrollPolicy())
	data := []byte{0, 1, 2, 255, 254, 7}
	res, operr := callOp(t, mc, "files.upload.begin", map[string]any{"workspaceId": wsID, "dir": ".", "path": "sub/pic.bin", "size": len(data), "mkdirs": true})
	if operr != nil {
		t.Fatalf("begin: %+v", operr)
	}
	id := res.(map[string]any)["uploadId"].(string)
	for off := 0; off < len(data); off += 4 {
		end := off + 4
		if end > len(data) {
			end = len(data)
		}
		if _, operr := callOp(t, mc, "files.upload.chunk", map[string]any{"uploadId": id, "offset": off, "content": base64.StdEncoding.EncodeToString(data[off:end])}); operr != nil {
			t.Fatalf("chunk at %d: %+v", off, operr)
		}
	}
	if _, operr := callOp(t, mc, "files.upload.commit", map[string]any{"uploadId": id}); operr != nil {
		t.Fatalf("commit: %+v", operr)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "sub", "pic.bin")); !bytes.Equal(got, data) {
		t.Errorf("bytes = %v", got)
	}
	_, operr = callOp(t, mc, "files.upload.begin", map[string]any{"workspaceId": wsID, "dir": ".", "path": "sub/pic.bin", "size": 1})
	if operr == nil || operr.Code != "conflict" {
		t.Fatalf("existing = %+v, want conflict", operr)
	}
	_, operr = callOp(t, mc, "files.upload.begin", map[string]any{"workspaceId": wsID, "dir": "../x", "path": "a", "size": 1})
	if operr == nil || operr.Code != "invalid" {
		t.Errorf("escape = %+v, want invalid", operr)
	}
	log, _ := os.ReadFile(auditPath)
	if !strings.Contains(string(log), `"action":"files.upload"`) || !strings.Contains(string(log), `"outcome":"conflict"`) {
		t.Errorf("audit = %s", log)
	}
}

func TestFilesUploadIsRefusedWithoutFileWrite(t *testing.T) {
	denied := freshEnrollPolicy()
	denied.FileWrite = policy.FileWriteDenied
	mc, wsID, dir, _ := writeMachine(t, denied)
	_, operr := callOp(t, mc, "files.upload.begin", map[string]any{"workspaceId": wsID, "dir": ".", "path": "x.bin", "size": 1})
	if operr == nil || operr.Code != "forbidden" {
		t.Fatalf("upload with fileWrite denied = %+v, want forbidden", operr)
	}
	off := freshEnrollPolicy()
	off.Files = policy.FilesOff
	mc2, ws2, _, _ := writeMachine(t, off)
	if _, operr := callOp(t, mc2, "files.upload.begin", map[string]any{"workspaceId": ws2, "dir": ".", "path": "x.bin", "size": 1}); operr == nil || operr.Code != "forbidden" {
		t.Fatalf("upload with files off = %+v", operr)
	}
	if entries, _ := os.ReadDir(dir); len(entries) > 0 {
		for _, e := range entries {
			if strings.Contains(e.Name(), "x.bin") {
				t.Errorf("a refused upload left %s", e.Name())
			}
		}
	}
}

func TestFilesZipOpsNeedFilesOnly(t *testing.T) {
	ro := freshEnrollPolicy()
	ro.FileWrite = policy.FileWriteDenied
	mc, wsID, dir, _ := writeMachine(t, ro)
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, operr := callOp(t, mc, "files.zip.begin", map[string]any{"workspaceId": wsID, "path": "."})
	if operr != nil {
		t.Fatalf("zip begin with fileWrite off: %+v", operr)
	}
	info := res.(files.ZipInfo)
	chunk, operr := callOp(t, mc, "files.zip.read", map[string]any{"zipId": info.ID})
	if operr != nil || !chunk.(files.ZipChunk).EOF {
		t.Fatalf("zip read: %+v %+v", chunk, operr)
	}
	off := freshEnrollPolicy()
	off.Files = policy.FilesOff
	mc2, ws2, _, _ := writeMachine(t, off)
	if _, operr := callOp(t, mc2, "files.zip.begin", map[string]any{"workspaceId": ws2, "path": "."}); operr == nil || operr.Code != "forbidden" {
		t.Errorf("zip with files off = %+v", operr)
	}
}

func TestFilesDownloadOpNeedsFilesNotFileWrite(t *testing.T) {
	ro := freshEnrollPolicy()
	ro.FileWrite = policy.FileWriteDenied
	mc, wsID, dir, _ := writeMachine(t, ro)
	data := []byte{0, 1, 2, 255}
	if err := os.WriteFile(filepath.Join(dir, "x.bin"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	res, operr := mc.Handle(context.Background(), "files.download", json.RawMessage(`{"workspaceId":"`+wsID+`","path":"x.bin"}`))
	if operr != nil {
		t.Fatalf("download with fileWrite off: %+v", operr)
	}
	if got, _ := base64.StdEncoding.DecodeString(res.(files.ReadResult).Content); !bytes.Equal(got, data) {
		t.Errorf("bytes = %v", got)
	}
	off := freshEnrollPolicy()
	off.Files = policy.FilesOff
	mc2, ws2, _, _ := writeMachine(t, off)
	if _, operr := mc2.Handle(context.Background(), "files.download", json.RawMessage(`{"workspaceId":"`+ws2+`","path":"x.bin"}`)); operr == nil || operr.Code != "forbidden" {
		t.Errorf("download with files off = %+v", operr)
	}
}
