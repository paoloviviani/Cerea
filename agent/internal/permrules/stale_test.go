package permrules

import "testing"

// the tool-visibility sentinel an older galopin opened every block with: a deny
// that can never apply (its pattern is not `*`).
var legacySentinel = Rule{"*", "<galopin:subagent-tools-visible>", Deny}

// An old-style stored Deny block is flagged, and a history that carries only
// what the ceiling still denies is not.
func TestFindStaleBlanketDeny(t *testing.T) {
	oldDeny := []Rule{
		legacySentinel,
		{"bash", "git status *", Allow},
		{"*", "*", Deny},
		{"edit", "*", Deny}, {"bash", "*", Deny}, {"webfetch", "*", Deny},
		{"read", "*", Ask}, {"read", "*", Allow},
	}
	if !FindStaleBlanketDeny(oldDeny, nil) {
		t.Errorf("an old-style Deny block: want stale")
	}
	if FindStaleBlanketDeny(nil, nil) {
		t.Errorf("no stored rules: want no stale deny")
	}
	// A deny the ceiling still imposes is live policy, not stale.
	live := []Rule{{"edit", "*", Deny}}
	if FindStaleBlanketDeny(live, live) {
		t.Errorf("stored == the ceiling's own deny: want no stale deny")
	}
	if FindStaleBlanketDeny([]Rule{legacySentinel}, nil) {
		t.Errorf("the sentinel alone: want no stale deny")
	}
	other := []Rule{{"read", "*", Deny}, {"session_spawn", "*", Deny}}
	if FindStaleBlanketDeny(other, nil) {
		t.Errorf("non-blanket denies: want no stale BLANKET deny")
	}
}

// A deny the ceiling no longer imposes is a stale machine policy.
func TestFindStalePolicyDenies(t *testing.T) {
	stored := []Rule{{"session_send", "*", Deny}}
	if !FindStalePolicyDenies(stored, nil, Ceiling{}) {
		t.Errorf("a deny nothing imposes: want stale policy")
	}
	if FindStalePolicyDenies(stored, nil, Ceiling{Max: map[string]Action{"session_send": Deny}}) {
		t.Errorf("a deny the ceiling still imposes: want no stale policy")
	}
	if FindStalePolicyDenies([]Rule{{"*", "*", Deny}, {"edit", "*", Deny}}, nil, Ceiling{}) {
		t.Errorf("blanket denies: want no stale POLICY verdict")
	}
	if FindStalePolicyDenies([]Rule{legacySentinel}, nil, Ceiling{}) {
		t.Errorf("the sentinel: want no stale policy")
	}
	if FindStalePolicyDenies(nil, nil, Ceiling{}) {
		t.Errorf("no stored rules: want no stale policy")
	}
}
