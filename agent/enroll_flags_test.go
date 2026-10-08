package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"reflect"
	"sort"
	"strconv"
	"testing"
)

// packaging/enroll-flags.json is the machine-readable list of enroll's flags
// that the /code panel's enroll dialog is built from. These tests are the drift
// check: a flag added to enroll without classifying it there (or removed without
// removing its entry, or given another kind or default) fails the build.

type enrollFlagEntry struct {
	Flag    string `json:"flag"`
	Kind    string `json:"kind"`
	Default any    `json:"default"`
	Exposed bool   `json:"exposed"`
	Retired bool   `json:"retired"`
}

type enrollFlagsFile struct {
	Version int               `json:"version"`
	Flags   []enrollFlagEntry `json:"flags"`
	Ceiling struct {
		Flag string `json:"flag"`
		Keys []struct {
			Key     string `json:"key"`
			Default string `json:"default"`
		} `json:"keys"`
	} `json:"ceiling"`
	DialogOnly []struct {
		Control string `json:"control"`
		Exposed bool   `json:"exposed"`
	} `json:"dialogOnly"`
}

func loadEnrollFlags(t *testing.T) enrollFlagsFile {
	t.Helper()
	raw, err := os.ReadFile("packaging/enroll-flags.json")
	if err != nil {
		t.Fatal(err)
	}
	var f enrollFlagsFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("packaging/enroll-flags.json: %v", err)
	}
	return f
}

// kindOf is the kind a registered flag has, by its Go value type. A repeatable
// flag is "list" or "keyAction"; the file says which, and both are one type.
func kindOf(f *flag.Flag) string {
	if bf, ok := f.Value.(interface{ IsBoolFlag() bool }); ok && bf.IsBoolFlag() {
		return "bool"
	}
	switch fmt.Sprintf("%T", f.Value) {
	case "*flag.intValue":
		return "int"
	case "*flag.stringValue":
		return "string"
	case "main.stringListFlag":
		return "list"
	}
	return "unknown:" + fmt.Sprintf("%T", f.Value)
}

func TestEnrollFlagsFileMatchesTheRegisteredFlags(t *testing.T) {
	file := loadEnrollFlags(t)
	fs, _ := newEnrollFlagSet(&enrollOptions{})
	registered := map[string]*flag.Flag{}
	fs.VisitAll(func(f *flag.Flag) { registered[f.Name] = f })

	listed := map[string]enrollFlagEntry{}
	for _, e := range file.Flags {
		if _, dup := listed[e.Flag]; dup {
			t.Errorf("%s is listed twice in enroll-flags.json", e.Flag)
		}
		listed[e.Flag] = e
	}
	var missing, stale []string
	for name := range registered {
		if _, ok := listed[name]; !ok {
			missing = append(missing, name)
		}
	}
	for name := range listed {
		if _, ok := registered[name]; !ok {
			stale = append(stale, name)
		}
	}
	sort.Strings(missing)
	sort.Strings(stale)
	if len(missing) > 0 {
		t.Errorf("enroll registers flags that packaging/enroll-flags.json does not classify: %v. "+
			"Add each with {flag, kind, default, exposed}: exposed:true if the enroll dialog must offer it, false for plumbing; "+
			"an exposed one also needs its control in PairDeviceDialog / codeEnrollCommand.", missing)
	}
	if len(stale) > 0 {
		t.Errorf("packaging/enroll-flags.json lists flags enroll no longer registers: %v", stale)
	}

	for name, f := range registered {
		e, ok := listed[name]
		if !ok {
			continue
		}
		kind := kindOf(f)
		if kind == "list" && e.Kind == "keyAction" {
			kind = "keyAction"
		}
		if kind != e.Kind {
			t.Errorf("%s: enroll registers a %s flag, the file says %s", name, kind, e.Kind)
		}
		if got, want := defaultWord(e), f.DefValue; got != want {
			t.Errorf("%s: the file's default is %q, enroll's is %q", name, got, want)
		}
	}
}

// defaultWord renders an entry's default the way flag.Flag.DefValue does.
func defaultWord(e enrollFlagEntry) string {
	switch v := e.Default.(type) {
	case bool:
		return strconv.FormatBool(v)
	case float64:
		return strconv.Itoa(int(v))
	case string:
		return v
	case []any:
		if len(v) == 0 {
			return ""
		}
	}
	return fmt.Sprintf("%v", e.Default)
}

// The flags the dialog must offer are exactly the ones the Addendum names; no
// other flag may be marked exposed, and none of those may be left out.
func TestEnrollFlagsExposedSetIsTheDialogsControlList(t *testing.T) {
	want := []string{
		"allow-free-models", "allow-opencode-provider", "allow-project-config", "file-deny",
		"max-terminals", "no-agent-tools", "no-background-subagents", "no-command-shell",
		"no-default-file-deny", "no-files", "no-terminal", "permission-max", "permission-rule",
		"workspace-root",
	}
	var got []string
	for _, e := range loadEnrollFlags(t).Flags {
		if e.Exposed {
			got = append(got, e.Flag)
		}
	}
	sort.Strings(got)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("exposed flags = %v, want %v", got, want)
	}
	plumbing := []string{"cerea", "client-id", "creds", "device", "discover", "gateway", "group", "issuer", "loopback", "output", "shim-port", "yes"}
	listed := map[string]enrollFlagEntry{}
	for _, e := range loadEnrollFlags(t).Flags {
		listed[e.Flag] = e
	}
	for _, name := range plumbing {
		if e, ok := listed[name]; !ok || e.Exposed {
			t.Errorf("%s must be listed as plumbing (exposed:false): %+v", name, e)
		}
	}
	if e := listed["allow-auto-accept"]; e.Exposed || !e.Retired {
		t.Errorf("allow-auto-accept is retired and must not be exposed: %+v", e)
	}
	d := loadEnrollFlags(t).DialogOnly
	if len(d) != 1 || d[0].Control != "install-opencode" || !d[0].Exposed {
		t.Errorf("dialogOnly = %+v, want the install-opencode control", d)
	}
}

// The ceiling table's defaults are enroll's own, so a dialog applying the
// replace-the-whole-set rule starts from the right rows.
func TestEnrollFlagsCeilingDefaultsAreEnrollsOwn(t *testing.T) {
	file := loadEnrollFlags(t)
	if file.Ceiling.Flag != "permission-max" {
		t.Fatalf("ceiling flag = %q", file.Ceiling.Flag)
	}
	defaults := defaultEnrollMax()
	var keys []string
	for _, k := range file.Ceiling.Keys {
		keys = append(keys, k.Key)
		want := defaults[k.Key]
		if want == "" {
			want = "allow"
		}
		if k.Default != want {
			t.Errorf("ceiling %s: the file says %s, enroll defaults to %s", k.Key, k.Default, want)
		}
	}
	wantKeys := []string{"edit", "bash", "webfetch", "task", "session_spawn", "session_send", "session_read", "schedule"}
	if !reflect.DeepEqual(keys, wantKeys) {
		t.Errorf("ceiling keys = %v, want %v", keys, wantKeys)
	}
	for k := range defaults {
		found := false
		for _, have := range keys {
			found = found || have == k
		}
		if !found {
			t.Errorf("enroll's default ceiling caps %s, which the file's table does not list", k)
		}
	}
}
