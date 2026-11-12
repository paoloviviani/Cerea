package browserrt

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The embedded bundle must be the one the sources in browser-runtime/ make: the bundle's first line
// carries the hash `npm run bundle` computed over src/*.ts and package.json (same order and bytes
// as scripts/bundle.mjs).
func TestBundleMatchesSources(t *testing.T) {
	root := filepath.Join("..", "..", "..", "browser-runtime")
	if _, err := os.Stat(filepath.Join(root, "src")); err != nil {
		t.Skip("browser-runtime/ sources are not in this checkout")
	}
	m := regexp.MustCompile(`source-hash: ([0-9a-f]{64})`).FindSubmatch(Bundle[:bytes.IndexByte(Bundle, '\n')])
	if m == nil {
		t.Fatal("the bundle has no source-hash header")
	}
	entries, err := os.ReadDir(filepath.Join(root, "src"))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".ts") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	h := sha256.New()
	for _, n := range names {
		b, err := os.ReadFile(filepath.Join(root, "src", n))
		if err != nil {
			t.Fatal(err)
		}
		h.Write([]byte(n))
		h.Write([]byte{0})
		h.Write(b)
	}
	pkg, err := os.ReadFile(filepath.Join(root, "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	h.Write(pkg)
	if got := hex.EncodeToString(h.Sum(nil)); got != string(m[1]) {
		t.Fatalf("the embedded bundle is stale (sources hash %s, bundle %s): run `npm run bundle` in browser-runtime/ and commit the result", got, m[1])
	}
}

func TestPackageJSONPinsPlaywrightExactly(t *testing.T) {
	if !regexp.MustCompile(`"playwright-core": "\d+\.\d+\.\d+(-[\w.-]+)?"`).Match(PackageJSON) {
		t.Fatalf("playwright-core must be pinned to an exact version: %s", PackageJSON)
	}
}

// Every npm package inlined into the bundle has its licence notice in THIRD_PARTY_LICENSES
// (the bundle names them on its second line; `npm run bundle` writes the notices).
func TestEveryInlinedPackageHasALicenceNotice(t *testing.T) {
	lines := strings.SplitN(string(Bundle), "\n", 3)
	if len(lines) < 3 || !strings.HasPrefix(lines[1], "// inlined: ") {
		t.Fatal("the bundle does not list what it carries")
	}
	notices, err := os.ReadFile(filepath.Join("..", "..", "THIRD_PARTY_LICENSES"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(notices), "#### BEGIN browser-runtime") {
		t.Fatal("THIRD_PARTY_LICENSES has no browser-runtime section: run `npm run bundle` in browser-runtime/")
	}
	pkgs := strings.Fields(strings.TrimPrefix(lines[1], "// inlined: "))
	if len(pkgs) < 3 {
		t.Fatalf("suspiciously few packages: %v", pkgs)
	}
	for _, p := range pkgs {
		name, version, _ := strings.Cut(p[1:], "@")
		name = p[:1] + name
		if !strings.Contains(string(notices), name+" "+version) {
			t.Errorf("no licence notice for %s: run `npm run bundle` in browser-runtime/ and commit the result", p)
		}
	}
}
