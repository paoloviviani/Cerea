const SHAPE = /^[a-zA-Z0-9_.-]+\.slice$/;
/** Slices systemd itself uses (and `-.slice`, the root): sandboxes must never be placed in or under them. */
const RESERVED = new Set(["system", "user", "machine"]);

/**
 * Whether `name` is a slice an operator may dedicate to sandboxes: a plain systemd slice name, not
 * the root slice, not one of systemd's own (a `-` in a name means nesting, so `user-1000.slice` is
 * under `user.slice`), and with no leading, trailing or doubled `-`.
 */
export function isSliceName(name: string): boolean {
	if (!SHAPE.test(name)) return false;
	const stem = name.slice(0, -".slice".length);
	if (stem.startsWith("-") || stem.endsWith("-") || stem.includes("--") || stem.startsWith("."))
		return false;
	return !RESERVED.has(stem.split("-")[0] ?? "");
}
