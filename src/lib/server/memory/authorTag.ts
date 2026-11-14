/** Who wrote a row, said before its text so a note never reads as the user's instruction by default. */
export function authorTag(source: "model" | "user" | undefined): string {
	return source === "user" ? "(typed by the user)" : "(saved by the assistant)";
}
