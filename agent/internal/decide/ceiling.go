package decide

// The two decisions below are the ONLY places that say what an unattended
// posture does with an ask the machine's ceiling forces to a person. ADR 0105
// currently says: auto hands such a card to no model (it is marked
// CeilingForced), and skip hard-refuses it. The owner is reconsidering how the
// ceiling and auto approval interact, so both are kept here, in one file, easy
// to change; nothing else in the code (nor the marking's wire name) encodes the
// answer. PENDING OWNER DECISION.

// ceilingForcesAHuman reports whether a card was put to a person by the ceiling
// (the key is capped at ask), which is what the `ceilingForced` mark on the ask
// frame says. res is the answer after the cap; cap is the cap for the ask.
func ceilingForcesAHuman(res Result, cap Verdict) bool {
	return res.Verdict == Card && cap == Card
}

// skipRefusesCeilingCard reports whether skip hard-refuses a card the ceiling
// forced (it never widens the ceiling) instead of allowing it.
func skipRefusesCeilingCard(res Result) bool {
	return res.CeilingForced
}
