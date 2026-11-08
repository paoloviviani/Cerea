/**
 * What the turn-details overlay shows for one assistant answer, kept on the
 * message (`Message.stats`) so a reload shows it again. Every field is
 * optional: a gateway or model that reports no usage leaves a gap, and the
 * overlay prints "—" for a gap.
 */

/** How the gateway handled a hidden value. */
export type RedactionMode = "restore" | "hide" | "block";

export type RedactionRule = {
	id?: string;
	name?: string;
	/** Who set the rule up: an administrator, or the user in their own settings. */
	owner?: "admin" | "user";
};

/** One kind of value that was hidden, summed over every call of the turn. */
export type RedactionEntity = {
	/** A Presidio entity (PERSON, IBAN_CODE...) or a custom pattern's name. */
	type: string;
	count: number;
	/** The gateway's own word for the mode; see `redactionModeOf`. */
	mode?: string;
	rule?: RedactionRule;
	/** Where the value came from: "user", "tool"... */
	sources: string[];
};

/** A hidden value, only stored when the user's "Show hidden values" was on. */
export type RedactionValue = {
	type: string;
	original: string;
	placeholder?: string;
};

export type TurnRedaction = {
	applied: boolean;
	blocked: boolean;
	entities: RedactionEntity[];
	/** Never exported, never shared (`stripRedactionValues`). */
	values?: RedactionValue[];
};

export type TurnStats = {
	/** The model's display name, as the user saw it in the picker. */
	model?: string;
	inputTokens?: number;
	outputTokens?: number;
	reasoningTokens?: number;
	/** Milliseconds from sending the request to the first token. */
	firstTokenMs?: number;
	/** Output tokens per second, from the first token to the end. */
	tokensPerSecond?: number;
	/**
	 * What the turn cost. Either as the gateway wrote it in the stream
	 * ("0.0042 USD", never parsed), or a plain decimal ("0.0042") read later
	 * from the gateway's usage by tag, with its currency in `costCurrency`.
	 */
	cost?: string;
	/** The ISO currency of `cost` when it is a plain decimal. */
	costCurrency?: string;
	/** Epoch milliseconds when the turn started. */
	at?: number;
	/** Present only when the gateway ran redaction for this turn. */
	redaction?: TurnRedaction;
};
