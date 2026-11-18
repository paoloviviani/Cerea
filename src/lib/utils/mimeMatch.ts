/**
 * Match a concrete MIME type against an allowlist that may contain wildcards
 * ("image/*" for any subtype, or a wildcard type). Shared by every entry point
 * that accepts user files (paste, drop, programmatic attachments) so they all
 * agree on what is allowed.
 */
export function mimeMatchesAllowlist(mime: string, allowlist: readonly string[]): boolean {
	const [type, subtype] = mime.split("/");
	return allowlist.some((allowed) => {
		const [allowedType, allowedSubtype] = allowed.split("/");
		return (
			(allowedType === "*" || allowedType === type) &&
			(allowedSubtype === "*" || allowedSubtype === subtype)
		);
	});
}

/**
 * Like `mimeMatchesAllowlist`, for a whole file. An allowlist entry that starts
 * with a dot (".jsonl") matches by extension. And where the allowlist takes
 * text (`text/*`), a file the browser gives no useful type, or one of a type
 * with no list entry (`.drawio`, `.excalidraw`, `.toml`), is not turned away
 * here: whether it is text is a question for its bytes, which the server
 * answers (and refuses with a clear message when it is binary). Images and
 * audio stay strict: they are offered only when the model or the user can use
 * them.
 */
export function fileMatchesAllowlist(
	file: { name: string; type: string },
	allowlist: readonly string[]
): boolean {
	const name = file.name.toLowerCase();
	if (allowlist.some((entry) => entry.startsWith(".") && name.endsWith(entry.toLowerCase()))) {
		return true;
	}
	if (mimeMatchesAllowlist(file.type, allowlist)) return true;
	const type = file.type.toLowerCase();
	if (type.startsWith("image/") || type.startsWith("audio/")) return false;
	return allowlist.some((entry) => entry.toLowerCase() === "text/*");
}
