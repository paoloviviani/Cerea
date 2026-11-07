/**
 * A chat whose very first send died on the stream before a single word came
 * back (a spent quota, a provider error). It holds nothing worth keeping, and
 * the user's next attempt from the empty chat page would otherwise leave
 * another one beside it: three failed sends, three chats with the same title.
 * The home page deletes the chat recorded here before it creates the next one.
 */
let abandoned: string | undefined;

export function markAbandonedFirstChat(id: string): void {
	abandoned = id;
}

export function takeAbandonedFirstChat(): string | undefined {
	const id = abandoned;
	abandoned = undefined;
	return id;
}

/** The user went back into the chat (to retry in place): it is theirs again. */
export function keepChat(id: string): void {
	if (abandoned === id) abandoned = undefined;
}
