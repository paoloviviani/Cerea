package opencode

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// pinnedVersionFile reads agent/packaging/opencode-version from disk, the
// file CI installs opencode from and the panel's TS constant is checked
// against: not through the embed, so the test also catches an embed that
// went stale or a file that is not a bare release number.
func pinnedVersionFile(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packaging", "opencode-version"))
	if err != nil {
		t.Fatalf("read the pinned version file: %v", err)
	}
	if !strings.HasSuffix(string(raw), "\n") || strings.Count(string(raw), "\n") != 1 {
		t.Fatalf("opencode-version = %q, want one release number and a newline", raw)
	}
	return strings.TrimSpace(string(raw))
}

func TestVersionIsThePinnedReleaseFile(t *testing.T) {
	want := pinnedVersionFile(t)
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(want) {
		t.Fatalf("opencode-version = %q, want MAJOR.MINOR.PATCH", want)
	}
	if got := (&Backend{}).Version(); got != want {
		t.Fatalf("Backend.Version() = %q, want %q (agent/packaging/opencode-version)", got, want)
	}
}
