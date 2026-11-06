package main

import (
	"galopin/internal/decide"
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

// machineHolds reports whether the owner denied the agents class locally: a
// machine that refuses delegation beats the delegate relationship.
func (at *agentTools) machineHolds(tool string) bool {
	return at.mc.live.Permission().Denied(decide.ClassAgents)
}
