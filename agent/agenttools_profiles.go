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

	"galopin/internal/permrules"
)

// Delegate profiles (PROTOCOL.md §6 "Delegate profiles"): named presets a
// spawner picks with session_spawn's `profile` argument. A profile carries a
// model, a permission mode and notes. The machine's owner defines them in
// profiles.json in galopin's state directory (read at every use, so an edit
// needs no restart); a few built-ins ship with galopin and a file entry of the
// same name replaces one.
//
// A profile can only make a delegate stricter. The mode is clamped to what the
// spawner itself has; the machine's ceiling and rules are composed last for
// every session whatever its word is, so a profile never lifts either.

const (
	profilesFileName = "profiles.json"
	// maxProfileNotes bounds a profile's notes, so the brief it is prepended to
	// stays within what a card can show.
	maxProfileNotes = 4 << 10
	maxProfileCount = 32
)

var profileNameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

// delegateProfile is one preset. Empty fields mean "as the spawner".
type delegateProfile struct {
	Model string `json:"model,omitempty"`
	// Mode is the permission mode: "plan", "ask" or "allow".
	Mode  string `json:"mode,omitempty"`
	Notes string `json:"notes,omitempty"`
	// Description is one line for the listing the model reads.
	Description string `json:"description,omitempty"`
}

// builtinProfiles are the defaults. None names a model: galopin cannot know
// which models a machine has.
func builtinProfiles() map[string]delegateProfile {
	return map[string]delegateProfile{
		"worker": {
			Description: "Does a piece of work with your own model and permissions.",
			Notes:       "You are a delegate. Do the task below, stay inside its scope, and end with a short final message: what you did, what you found, what is left.",
		},
		"reviewer": {
			Mode:        "plan",
			Description: "Read-only second opinion: reviews work or an answer critically and reports.",
			Notes:       "You are a reviewer giving a second opinion. You are read-only: change nothing. Check the work or answer below against the evidence yourself rather than trusting it; say plainly what is right, what is wrong or missing, and how sure you are. Your final message is the review, short and self-contained.",
		},
		"explorer": {
			Mode:        "plan",
			Description: "Read-only research: surveys code or a question and reports findings.",
			Notes:       "You are a read-only researcher: change nothing. Find the answer to the question below from the code and files, cite paths and symbols, and end with a short final message of findings.",
		},
	}
}

// parseProfiles reads and validates a profiles file's body. Every problem is
// reported with the profile it is in; nothing partial is returned.
func parseProfiles(body []byte) (map[string]delegateProfile, error) {
	var disk struct {
		Profiles map[string]delegateProfile `json:"profiles"`
	}
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&disk); err != nil {
		return nil, fmt.Errorf("%s: %v", profilesFileName, err)
	}
	if len(disk.Profiles) > maxProfileCount {
		return nil, fmt.Errorf("%s: at most %d profiles", profilesFileName, maxProfileCount)
	}
	for name, p := range disk.Profiles {
		if !profileNameRE.MatchString(name) {
			return nil, fmt.Errorf("%s: profile name %q must be 1-32 characters of a-z, 0-9, - or _", profilesFileName, name)
		}
		if _, err := profileWord(p.Mode); err != nil {
			return nil, fmt.Errorf("%s: profile %q: %v", profilesFileName, name, err)
		}
		if len(p.Notes) > maxProfileNotes {
			return nil, fmt.Errorf("%s: profile %q: notes are longer than %d bytes", profilesFileName, name, maxProfileNotes)
		}
		if strings.ContainsAny(p.Model, " \t\r\n") {
			return nil, fmt.Errorf("%s: profile %q: model %q is not a model id", profilesFileName, name, p.Model)
		}
	}
	return disk.Profiles, nil
}

// loadProfiles is the built-ins with the state directory's file laid over
// them. A missing file is the built-ins alone; an unreadable or invalid one is
// an error (the built-ins are then still usable through builtinProfiles, but
// a spawn that names a profile is refused with the problem, never silently
// run without the owner's intent).
func loadProfiles(stateDir string) (map[string]delegateProfile, error) {
	out := builtinProfiles()
	if stateDir == "" {
		return out, nil
	}
	body, err := os.ReadFile(filepath.Join(stateDir, profilesFileName))
	if os.IsNotExist(err) {
		return out, nil
	}
	if err != nil {
		return nil, fmt.Errorf("%s: %v", profilesFileName, err)
	}
	file, err := parseProfiles(body)
	if err != nil {
		return nil, err
	}
	for k, v := range file {
		out[k] = v
	}
	return out, nil
}

// profileWord maps a profile's mode to a permission word: plan is the deny
// word. The empty mode is "" (as the spawner).
func profileWord(mode string) (permrules.Action, error) {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "":
		return "", nil
	case "plan":
		return permrules.Deny, nil
	case "ask":
		return permrules.Ask, nil
	case "allow":
		return permrules.Allow, nil
	}
	return "", fmt.Errorf("mode %q must be plan, ask or allow", mode)
}

// clampWord is the word a delegate gets: the profile's, never looser than the
// spawner's own. clamped reports that the profile asked for more. The empty
// profile word is the spawner's.
func clampWord(profile, spawner permrules.Action) (word permrules.Action, clamped bool) {
	if profile == "" {
		return spawner, false
	}
	word = permrules.Min(profile, spawner)
	return word, word != profile
}

func modeName(w permrules.Action) string {
	if w == permrules.Deny {
		return "plan"
	}
	return string(w)
}

// profileNames lists names sorted, with the one-line descriptions.
func profileListing(ps map[string]delegateProfile) []map[string]any {
	names := make([]string, 0, len(ps))
	for n := range ps {
		names = append(names, n)
	}
	sort.Strings(names)
	rows := make([]map[string]any, 0, len(names))
	for _, n := range names {
		p := ps[n]
		row := map[string]any{"name": n, "description": p.Description}
		if p.Model != "" {
			row["model"] = p.Model
		}
		if p.Mode != "" {
			row["mode"] = strings.ToLower(strings.TrimSpace(p.Mode))
		}
		rows = append(rows, row)
	}
	return rows
}

// profileNamesText is "a, b, c" for refusals.
func profileNamesText(ps map[string]delegateProfile) string {
	var names []string
	for _, r := range profileListing(ps) {
		names = append(names, r["name"].(string))
	}
	return strings.Join(names, ", ")
}

// briefWith prepends a profile's notes to the brief.
func briefWith(notes, prompt string) string {
	if strings.TrimSpace(notes) == "" {
		return prompt
	}
	return strings.TrimSpace(notes) + "\n\n---\n\n" + prompt
}

// resolveProfile is the profile a spawn names: the zero profile for "", else
// the built-in or file entry. An unknown name, or a profiles file that does not
// parse, is a refusal the model reads (the second lists what is available).
func (at *agentTools) resolveProfile(name string) (delegateProfile, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return delegateProfile{}, nil
	}
	ps, err := loadProfiles(at.stateDir)
	if err != nil {
		return delegateProfile{}, refuse("the delegate profiles cannot be used: %v", err)
	}
	p, ok := ps[name]
	if !ok {
		return delegateProfile{}, refuse("no delegate profile %q; available: %s", name, profileNamesText(ps))
	}
	return p, nil
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

// profiles implements session_profiles: the available presets, read-only.
func (at *agentTools) profiles() (string, error) {
	ps, err := loadProfiles(at.stateDir)
	if err != nil {
		return "", refuse("the delegate profiles cannot be read: %v", err)
	}
	body, err := json.Marshal(profileListing(ps))
	return string(body), err
}
