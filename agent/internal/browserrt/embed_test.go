package browserrt

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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

// The install is pinned by tarball integrity: the lock names exactly one package, at the version
// package.json pins, with a sha512 and the npm registry address, and it is the one the runtime's
// own lock (browser-runtime/package-lock.json) has.
func TestInstallLockPinsThePlaywrightTarballByIntegrity(t *testing.T) {
	var lock struct {
		LockfileVersion int `json:"lockfileVersion"`
		Packages        map[string]struct {
			Version   string `json:"version"`
			Resolved  string `json:"resolved"`
			Integrity string `json:"integrity"`
		} `json:"packages"`
	}
	if err := json.Unmarshal(PackageLock, &lock); err != nil {
		t.Fatal(err)
	}
	var pkg struct {
		Dependencies map[string]string `json:"dependencies"`
	}
	if err := json.Unmarshal(PackageJSON, &pkg); err != nil {
		t.Fatal(err)
	}
	if lock.LockfileVersion != 3 || len(lock.Packages) != 2 {
		t.Fatalf("the lock must hold the root and playwright-core only: %+v", lock.Packages)
	}
	e := lock.Packages["node_modules/playwright-core"]
	if e.Version == "" || e.Version != pkg.Dependencies["playwright-core"] {
		t.Errorf("lock version %q, package.json %q", e.Version, pkg.Dependencies["playwright-core"])
	}
	if !regexp.MustCompile(`^sha512-[A-Za-z0-9+/]{86}==$`).MatchString(e.Integrity) {
		t.Errorf("no sha512 integrity: %q", e.Integrity)
	}
	if !strings.HasPrefix(e.Resolved, "https://registry.npmjs.org/playwright-core/-/playwright-core-"+e.Version+".tgz") {
		t.Errorf("resolved %q", e.Resolved)
	}
	own, err := os.ReadFile(filepath.Join("..", "..", "..", "browser-runtime", "package-lock.json"))
	if err != nil {
		t.Skip("browser-runtime/ is not in this checkout")
	}
	var runtimeLock struct {
		Packages map[string]struct {
			Integrity string `json:"integrity"`
		} `json:"packages"`
	}
	if err := json.Unmarshal(own, &runtimeLock); err != nil {
		t.Fatal(err)
	}
	if runtimeLock.Packages["node_modules/playwright-core"].Integrity != e.Integrity {
		t.Error("the embedded lock disagrees with browser-runtime/package-lock.json: run `npm run bundle`")
	}
}
