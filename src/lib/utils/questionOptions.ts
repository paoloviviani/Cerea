/** "Other", "Something else", "Type my own…": the catch-all a form already provides. */
export function isCatchAllLabel(label: string): boolean {
	// Whole label only (plus a trailing aside), so "Other people's code" stays.
	return /^\s*(other|others|something else|anything else|none of (the|these)( above)?|(let me )?(type|write) (my|your|a) own( answer)?|custom( answer)?)\s*([(:\-\u2013\u2014\u2026.,].*)?$/i.test(
		label
	);
}
