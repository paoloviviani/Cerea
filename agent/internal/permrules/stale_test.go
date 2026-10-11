package permrules

import "testing"

// An old-style stored Deny block — what ComposeParts wrote before deny-as-ask
// (sentinel, exceptions before the block, the Deny word, the schedule stop
// tools) — is flagged against a current composition that no longer contains
// it, and a new-style history is not.
func TestFindStaleBlanketDeny(t *testing.T) {
	oldDeny := []Rule{
		ToolVisibilitySentinel,
		{"bash", "git status *", Allow}, // an exception, kept but inert
		{"*", "*", Deny},
		{"edit", "*", Deny}, {"bash", "*", Deny}, {"webfetch", "*", Deny},
		{"websearch", "*", Deny}, {"codesearch", "*", Deny}, {"task", "*", Deny},
		{"read", "*", Ask}, {"read", "*", Allow},
		{"schedule_list", "*", Ask}, {"schedule_update", "*", Ask}, {"schedule_delete", "*", Ask},
	}
	current := Compose(Layers{}, Selector{Mode: Allow}, buildAgent)
	if !FindStaleBlanketDeny(oldDeny, current) {
		t.Errorf("an old-style Deny block against an Allow composition: want stale")
	}
	// A history composed the new way leaves nothing stale behind.
	fresh := Compose(Layers{}, Selector{Mode: Allow}, buildAgent)
	if FindStaleBlanketDeny(fresh, current) {
		t.Errorf("a new-style composition: want no stale deny")
	}
	if FindStaleBlanketDeny(nil, current) {
		t.Errorf("no stored rules: want no stale deny")
	}
	// A deny the composition still carries is live policy, not stale: the
	// machine's own deny and the ceiling's tail.
	l := Layers{
		Own:     OwnRules(map[string]Action{"webfetch": Deny}),
		Ceiling: Ceiling{Max: map[string]Action{"edit": Deny}},
	}
	withPolicy := Compose(l, Selector{Mode: Allow}, buildAgent)
	if FindStaleBlanketDeny(withPolicy, withPolicy) {
		t.Errorf("stored == composed, policy denies included: want no stale deny")
	}
	// The sentinel alone never counts.
	if FindStaleBlanketDeny([]Rule{ToolVisibilitySentinel}, current) {
		t.Errorf("the sentinel alone: want no stale deny")
	}
	// A non-blanket deny (a read-only rule, a coordination key) is not a
	// blanket deny — the ceiling detector (B3) owns those.
	other := []Rule{{"read", "*", Deny}, {"session_spawn", "*", Deny}}
	if FindStaleBlanketDeny(other, current) {
		t.Errorf("non-blanket denies: want no stale BLANKET deny")
	}
}
