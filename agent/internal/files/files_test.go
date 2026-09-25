package files

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, root, rel, body string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func git(t *testing.T, root string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", root, "-c", "user.email=t@example.org", "-c", "user.name=t"}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v (%s)", args, err, out)
	}
}

func names(entries []Entry) []string {
	var out []string
	for _, e := range entries {
		out = append(out, e.Name)
	}
	return out
}

// workspace builds a small repo with a secret, an escaping symlink and an
// ignored directory, next to an outside file the symlink points at.
func workspace(t *testing.T) (root, outside string) {
	t.Helper()
	base := t.TempDir()
	root = filepath.Join(base, "ws")
	outside = filepath.Join(base, "outside.txt")
	if err := os.WriteFile(outside, []byte("secret outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	write(t, root, "src/app.ts", "export const a = 1;\n")
	write(t, root, "src/file10.ts", "")
	write(t, root, "src/file2.ts", "")
	write(t, root, ".env", "TOKEN=hunter2\n")
	write(t, root, ".env.example", "TOKEN=\n")
	write(t, root, "README.md", "# hi\n")
	write(t, root, ".gitignore", "build/\n")
	write(t, root, "build/out.js", "x")
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("src/app.ts", filepath.Join(root, "inside-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("nowhere", filepath.Join(root, "dangling")); err != nil {
		t.Fatal(err)
	}
	git(t, root, "init", "-q")
	git(t, root, "add", "src/app.ts", "README.md", ".gitignore")
	git(t, root, "commit", "-q", "-m", "init")
	write(t, root, "src/app.ts", "export const a = 2;\n")
	return root, outside
}

var defaultDeny = []string{".env", ".env.*", "!.env.example", "!.env.sample", "!.env.template", "*.pem"}

func TestListConfinesAndDecorates(t *testing.T) {
	root, _ := workspace(t)
	s := New(defaultDeny)
	res, err := s.List(context.Background(), root, ".", true)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(names(res.Entries), ",")
	if got != "build,src,.env,.env.example,.gitignore,dangling,escape,inside-link,README.md" {
		t.Errorf("entries = %s (dirs first, natural order, no .git)", got)
	}
	byName := map[string]Entry{}
	for _, e := range res.Entries {
		byName[e.Name] = e
	}
	if !byName[".env"].Redacted || byName[".env.example"].Redacted {
		t.Errorf("redaction: .env=%v .env.example=%v", byName[".env"].Redacted, byName[".env.example"].Redacted)
	}
	if !byName[".env"].Hidden || byName["README.md"].Hidden {
		t.Error("hidden should follow the leading dot")
	}
	if !byName["build"].Ignored || byName["src"].Ignored {
		t.Errorf("ignored: build=%v src=%v", byName["build"].Ignored, byName["src"].Ignored)
	}
	if l := byName["escape"].Symlink; l == nil || !l.Escapes {
		t.Errorf("escape symlink = %+v, want escapes", l)
	}
	if l := byName["inside-link"].Symlink; l == nil || l.Escapes || l.Dangling {
		t.Errorf("inside symlink = %+v, want neither", l)
	}
	if l := byName["dangling"].Symlink; l == nil || !l.Dangling {
		t.Errorf("dangling symlink = %+v", l)
	}

	sub, err := s.List(context.Background(), root, "src", false)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(names(sub.Entries), ","); got != "app.ts,file2.ts,file10.ts" {
		t.Errorf("src = %s, want natural sort", got)
	}
}

func TestPathsCannotLeaveTheWorkspace(t *testing.T) {
	root, _ := workspace(t)
	s := New(nil)
	for _, rel := range []string{"../outside.txt", "/etc/passwd", "src/../../outside.txt", "a\x00b", `..\x`} {
		if _, err := s.Read(root, rel, 0, 0, ""); !errors.Is(err, ErrInvalid) {
			t.Errorf("Read(%q) err = %v, want invalid", rel, err)
		}
	}
	// A symlink to outside the root is listed but never read through.
	if _, err := s.Read(root, "escape", 0, 0, ""); !errors.Is(err, ErrForbidden) {
		t.Errorf("reading an escaping symlink err = %v, want forbidden", err)
	}
	// A symlink inside the root reads as its target.
	res, err := s.Read(root, "inside-link", 0, 0, "")
	if err != nil || !strings.Contains(res.Content, "const a = 2") {
		t.Errorf("inside link read = %+v, %v", res, err)
	}
	if _, err := s.List(context.Background(), root, ".git", false); !errors.Is(err, ErrForbidden) {
		t.Errorf("listing .git err = %v, want forbidden", err)
	}
}

// A directory swapped for a symlink out of the root, after the path was
// validated, is still refused: resolution happens inside os.Root.
func TestSwappedDirectoryIsStillConfined(t *testing.T) {
	root, outside := workspace(t)
	s := New(nil)
	if err := os.RemoveAll(filepath.Join(root, "src")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(outside), filepath.Join(root, "src")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Read(root, "src/outside.txt", 0, 0, ""); err == nil {
		t.Fatal("read through a swapped-in symlink directory succeeded")
	}
}

func TestReadRedactedTextBinaryAndImage(t *testing.T) {
	root, _ := workspace(t)
	s := New(defaultDeny)
	if _, err := s.Read(root, ".env", 0, 0, ""); !errors.Is(err, ErrForbidden) {
		t.Errorf("reading .env err = %v, want forbidden", err)
	}

	// A range ending mid-rune is trimmed to the boundary.
	write(t, root, "utf8.txt", "aé"+strings.Repeat("b", 10))
	res, err := s.Read(root, "utf8.txt", 0, 2, "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Content != "a" || res.Length != 1 || res.EOF {
		t.Errorf("range = %q len %d eof %v, want the é not split", res.Content, res.Length, res.EOF)
	}
	rest, _ := s.Read(root, "utf8.txt", res.Length, 0, "")
	if rest.Content != "é"+strings.Repeat("b", 10) || !rest.EOF {
		t.Errorf("rest = %q eof %v", rest.Content, rest.EOF)
	}

	write(t, root, "blob.bin", "PK\x03\x04\x00\x00binary")
	bin, err := s.Read(root, "blob.bin", 0, 0, "")
	if err != nil || bin.Kind != "binary" || bin.Content != "" || bin.Encoding != "none" {
		t.Errorf("binary = %+v, %v", bin, err)
	}
	b64, _ := s.Read(root, "blob.bin", 0, 0, "base64")
	if raw, _ := base64.StdEncoding.DecodeString(b64.Content); string(raw) != "PK\x03\x04\x00\x00binary" {
		t.Errorf("base64 read = %q", b64.Content)
	}

	write(t, root, "pic.png", "\x89PNG fake")
	img, err := s.Read(root, "pic.png", 0, 0, "")
	if err != nil || img.Kind != "image" || img.Mime != "image/png" || img.Encoding != "base64" {
		t.Errorf("image = %+v, %v", img, err)
	}
	big := make([]byte, MaxImageBytes+1)
	if err := os.WriteFile(filepath.Join(root, "huge.png"), big, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Read(root, "huge.png", 0, 0, ""); !errors.Is(err, ErrTooLarge) {
		t.Errorf("huge image err = %v, want too_large", err)
	}
}

func TestStatusReportsPorcelainCodes(t *testing.T) {
	root, _ := workspace(t)
	s := New(nil)
	res, err := s.Status(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	if !res.IsGitRepo || res.Branch == "" {
		t.Fatalf("status = %+v, want a git repo with a branch", res)
	}
	codes := map[string]string{}
	for _, e := range res.Entries {
		codes[e.Path] = e.X + e.Y
	}
	if codes["src/app.ts"] != ".M" {
		t.Errorf("src/app.ts = %q, want .M (modified in the worktree)", codes["src/app.ts"])
	}
	if codes["src/file2.ts"] != "??" {
		t.Errorf("src/file2.ts = %q, want ?? (untracked)", codes["src/file2.ts"])
	}

	plain := t.TempDir()
	res, err = s.Status(context.Background(), plain)
	if err != nil || res.IsGitRepo {
		t.Errorf("a non-repo = %+v, %v", res, err)
	}
}

func TestMatchDeny(t *testing.T) {
	deny := []string{".env", ".env.*", "!.env.example", ".aws/credentials", "secrets.y*ml", "id_rsa*"}
	for rel, want := range map[string]bool{
		".env": true, "api/.env": true, ".env.local": true, ".env.example": false,
		"home/.aws/credentials": true, ".aws/config": false, "k8s/secrets.yaml": true,
		"secrets.yml": true, "id_rsa.pub": true, "README.md": false,
	} {
		if got := MatchDeny(deny, rel); got != want {
			t.Errorf("MatchDeny(%q) = %v, want %v", rel, got, want)
		}
	}
}
