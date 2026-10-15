package main

import (
	"galopin/internal/permrules"
)

// Delegates (ADR 0099). A session created by session_spawn is a delegate of
// its spawner: a direct link, read from the persisted spawn markers, not
// transitive. Between the two, and only these, a card is not raised for the
// spawner's read of the delegate, the spawner's send to it, or the delegate's
// send to the spawner. Every other limit stands.

// delegateDirection says how two sessions relate through the spawn markers.
type delegateDirection int

const (
	notDelegates delegateDirection = iota
	// callerSpawned: target is a delegate of the caller.
	callerSpawned
	// callerIsDelegate: the caller is a delegate of the target.
	callerIsDelegate
)

// IsDelegatePair is the predicate the permission decision function consumes
// (ADR 0097's "delegate rule"): is target the caller's own delegate, or the
// caller its target's delegate. Only the direct spawn link counts.
func (at *agentTools) IsDelegatePair(callerID, targetID string) delegateDirection {
	marks := at.host.SpawnMarks()
	if m, ok := marks[targetID]; ok && m.SessionID == callerID {
		return callerSpawned
	}
	if m, ok := marks[callerID]; ok && m.SessionID == targetID {
		return callerIsDelegate
	}
	return notDelegates
}

// machineHolds reports whether the machine's own rules cap the tool at ask or
// deny: the ceiling (Max) or an explicit machine rule. Only these beat the
// delegate relationship; the session's own word does not.
func (at *agentTools) machineHolds(tool string) bool {
	perm := at.mc.live.Permission()
	for _, m := range []map[string]string{perm.Max, perm.Rules} {
		switch permrules.Action(m[tool]) {
		case permrules.Ask, permrules.Deny:
			return true
		}
	}
	return false
}
