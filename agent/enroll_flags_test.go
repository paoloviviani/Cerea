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

	"galopin/internal/decide"
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
	Version    int               `json:"version"`
	Flags      []enrollFlagEntry `json:"flags"`
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
		"allow-file-write", "allow-free-models", "allow-opencode-provider", "allow-project-config", "default-group", "file-deny",
		"limit", "max-terminals", "no-agent-tools", "no-background-subagents", "no-command-shell",
		"no-default-file-deny", "no-files", "no-terminal",
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

// The class table in enroll-flags.json is the decision package's own.
func TestEnrollFlagsLimitsAreTheClassTable(t *testing.T) {
	raw, err := os.ReadFile("packaging/enroll-flags.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Limits struct {
			Flag    string `json:"flag"`
			Classes []struct {
				Class   string   `json:"class"`
				Default string   `json:"default"`
				Allowed []string `json:"allowed"`
			} `json:"classes"`
		} `json:"limits"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if f.Limits.Flag != "limit" || len(f.Limits.Classes) != len(decide.Classes) {
		t.Fatalf("limits = %+v", f.Limits)
	}
	for i, c := range decide.Classes {
		row := f.Limits.Classes[i]
		if row.Class != string(c) || row.Default != decide.DefaultLimit(c).Word() {
			t.Errorf("row %d = %+v, want class %s default %s", i, row, c, decide.DefaultLimit(c).Word())
		}
		var allowed []string
		for _, l := range []decide.Limit{decide.Never, decide.AskLimit, decide.Run, decide.Stop} {
			if c.Allows(l) {
				allowed = append(allowed, l.Word())
			}
		}
		if !reflect.DeepEqual(allowed, row.Allowed) {
			t.Errorf("%s allowed %v in the file, %v in code", c, row.Allowed, allowed)
		}
	}
}
