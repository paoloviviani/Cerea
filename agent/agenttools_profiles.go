package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"galopin/internal/backend"
	"galopin/internal/fsutil"
	"galopin/internal/link"
	"galopin/internal/policy"
)

// Delegate profiles (PROTOCOL.md §6 "Delegate profiles"): a profile is a name
// and a model. A machine has any number of them (at most 32) and at most one
// default, which a delegation that names no profile uses. They live in
// profiles.json in galopin's state directory, which galopin owns: the machine's
// owner edits them from the Cerea panel (`profiles.list`, `profiles.set`).
//
// A model is not a permission. A delegate never gets more permission than its
// spawner whichever model it runs on; the machine's ceiling and rules are
// composed last for every session.

const (
	profilesFileName = "profiles.json"
	maxProfileCount  = 32
)

var profileNameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

// delegateProfile is one profile: the model a delegate runs on.
type delegateProfile struct {
	Model string `json:"model"`
}

// profileSet is the whole file: the profiles and which one is the default.
type profileSet struct {
	Default  *string                    `json:"default"`
	Profiles map[string]delegateProfile `json:"profiles"`
}

func (s profileSet) names() []string {
	names := make([]string, 0, len(s.Profiles))
	for n := range s.Profiles {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// wire is the set as the ops and session_profiles show it.
func (s profileSet) wire() map[string]any {
	profiles := map[string]delegateProfile{}
	for n, p := range s.Profiles {
		profiles[n] = p
	}
	var def any
	if s.Default != nil {
		def = *s.Default
	}
	return map[string]any{"default": def, "profiles": profiles}
}

// parseProfiles reads the file's body. It accepts the shape galopin writes and,
// gracefully, the one before it (entries with a model keep it; entries without
// one, with an unusable name or beyond the count are dropped; mode, notes,
// description and unknown fields are ignored; a default that names nothing is
// no default). Only a body that is not JSON of the right outline is an error.
func parseProfiles(body []byte) (profileSet, error) {
	var disk struct {
		Default  *string                    `json:"default"`
		Profiles map[string]json.RawMessage `json:"profiles"`
	}
	if err := json.Unmarshal(body, &disk); err != nil {
		return profileSet{}, fmt.Errorf("%s: %v", profilesFileName, err)
	}
	out := profileSet{Profiles: map[string]delegateProfile{}}
	names := make([]string, 0, len(disk.Profiles))
	for n := range disk.Profiles {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		var p delegateProfile
		if json.Unmarshal(disk.Profiles[n], &p) != nil {
			continue
		}
		p.Model = strings.TrimSpace(p.Model)
		if !profileNameRE.MatchString(n) || p.Model == "" || strings.ContainsAny(p.Model, " \t\r\n") {
			continue
		}
		if len(out.Profiles) >= maxProfileCount {
			break
		}
		out.Profiles[n] = p
	}
	if disk.Default != nil {
		if _, ok := out.Profiles[*disk.Default]; ok {
			d := *disk.Default
			out.Default = &d
		}
	}
	return out, nil
}

// loadProfiles reads the state directory's file. A missing file is no profiles.
func loadProfiles(stateDir string) (profileSet, error) {
	empty := profileSet{Profiles: map[string]delegateProfile{}}
	if stateDir == "" {
		return empty, nil
	}
	body, err := os.ReadFile(filepath.Join(stateDir, profilesFileName))
	if os.IsNotExist(err) {
		return empty, nil
	}
	if err != nil {
		return profileSet{}, fmt.Errorf("%s: %v", profilesFileName, err)
	}
	return parseProfiles(body)
}

// validateProfileSet checks a set an owner asks to store. offered is the model
// ids this machine offers; a profile's model must be one of them.
func validateProfileSet(s profileSet, offered map[string]bool) error {
	if len(s.Profiles) > maxProfileCount {
		return fmt.Errorf("at most %d profiles", maxProfileCount)
	}
	for _, n := range s.names() {
		if !profileNameRE.MatchString(n) {
			return fmt.Errorf("profile name %q must be 1-32 characters of a-z, 0-9, - or _, starting with a letter or digit", n)
		}
		m := s.Profiles[n].Model
		if m == "" {
			return fmt.Errorf("profile %q needs a model", n)
		}
		if !offered[m] {
			return fmt.Errorf("profile %q: model %q is not offered by this machine", n, m)
		}
	}
	if s.Default != nil {
		if _, ok := s.Profiles[*s.Default]; !ok {
			return fmt.Errorf("the default profile %q is not one of the profiles", *s.Default)
		}
	}
	return nil
}

// resolveProfile is the profile a delegation uses: the named one, or, for "",
// the default (the zero profile when there is none, which means the spawner's
// model). name is the profile's name ("" for none). An unknown name, or a
// profiles file that does not parse, is a refusal the model reads.
func (at *agentTools) resolveProfile(requested string) (prof delegateProfile, name string, err error) {
	requested = strings.TrimSpace(requested)
	ps, lerr := loadProfiles(at.stateDir)
	if lerr != nil {
		return delegateProfile{}, "", refuse("the delegate profiles cannot be used: %v", lerr)
	}
	if requested == "" {
		if ps.Default == nil {
			return delegateProfile{}, "", nil
		}
		requested = *ps.Default
	}
	p, ok := ps.Profiles[requested]
	if !ok {
		if len(ps.Profiles) == 0 {
			return delegateProfile{}, "", refuse("no delegate profile %q: this machine has no profiles", requested)
		}
		return delegateProfile{}, "", refuse("no delegate profile %q; available: %s", requested, strings.Join(ps.names(), ", "))
	}
	return p, requested, nil
}

// checkProfileModel refuses a profile model this workspace does not offer.
func (at *agentTools) checkProfileModel(ctx context.Context, dir, model string) error {
	models, err := at.mc.back.Models(ctx, dir)
	if err != nil {
		return err
	}
	for _, m := range models {
		if m.ID == model {
			return nil
		}
	}
	return refuse("the profile's model %q is not available in this workspace", model)
}

// profiles implements session_profiles: the machine's profiles and default,
// read-only.
func (at *agentTools) profiles() (string, error) {
	ps, err := loadProfiles(at.stateDir)
	if err != nil {
		return "", refuse("the delegate profiles cannot be read: %v", err)
	}
	body, err := json.Marshal(ps.wire())
	return string(body), err
}

// offeredModels is the model list this machine offers for sessions: what
// backend.models answers (the free-model gate applied), without a workspace.
func (mc *machine) offeredModels(ctx context.Context, dir string) (models []backend.Model, hidden int, err error) {
	all, err := mc.back.Models(ctx, dir)
	if err != nil {
		return nil, 0, err
	}
	for _, m := range all {
		if !mc.pol.AllowFreeModels && m.ProviderID != policy.GatewayProviderID {
			hidden++
			continue
		}
		models = append(models, m)
	}
	return models, hidden, nil
}

// profilesAvailable: the machine has the agent tools profiles are for.
func (mc *machine) profilesAvailable() bool { return mc.agentTools != nil }

// opProfilesList answers profiles.list {} -> {default, profiles}.
func (mc *machine) opProfilesList(_ context.Context, _ json.RawMessage) (any, *link.OpError) {
	if !mc.profilesAvailable() {
		return nil, opErrf("unsupported", "this machine has no delegate profiles (the agent tools are off)")
	}
	ps, err := loadProfiles(mc.agentTools.stateDir)
	if err != nil {
		return nil, opErrf("invalid", "%v", err)
	}
	return ps.wire(), nil
}

// opProfilesSet answers profiles.set {default, profiles}: it replaces the whole
// set, atomically, after validating it. The answer is the stored set.
func (mc *machine) opProfilesSet(ctx context.Context, args json.RawMessage) (any, *link.OpError) {
	if !mc.profilesAvailable() {
		return nil, opErrf("unsupported", "this machine has no delegate profiles (the agent tools are off)")
	}
	at := mc.agentTools
	if at.stateDir == "" {
		return nil, opErrf("unsupported", "this machine has no state directory for profiles")
	}
	var a struct {
		Default  *string                    `json:"default"`
		Profiles map[string]delegateProfile `json:"profiles"`
	}
	dec := json.NewDecoder(strings.NewReader(string(args)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&a); err != nil || a.Profiles == nil {
		return nil, opErrf("invalid", "profiles.set needs {default, profiles}")
	}
	set := profileSet{Default: a.Default, Profiles: a.Profiles}
	for n, p := range set.Profiles {
		p.Model = strings.TrimSpace(p.Model)
		set.Profiles[n] = p
	}
	models, _, err := mc.offeredModels(ctx, "")
	if err != nil {
		return nil, backendErr(err)
	}
	offered := map[string]bool{}
	for _, m := range models {
		offered[m.ID] = true
	}
	if err := validateProfileSet(set, offered); err != nil {
		return nil, opErrf("invalid", "%v", err)
	}
	body, err := json.MarshalIndent(set.wire(), "", "  ")
	if err != nil {
		return nil, opErrf("unavailable", "%v", err)
	}
	at.profilesMu.Lock()
	err = fsutil.WriteFileAtomic(filepath.Join(at.stateDir, profilesFileName), append(body, '\n'), 0o600)
	at.profilesMu.Unlock()
	if err != nil {
		return nil, opErrf("unavailable", "writing %s: %v", profilesFileName, err)
	}
	def := ""
	if set.Default != nil {
		def = *set.Default
	}
	mc.audit.profilesSet(len(set.Profiles), def)
	return set.wire(), nil
}
