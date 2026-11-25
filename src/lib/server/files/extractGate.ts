import { extractorAvailable } from "./extractDocument";
import { userDocumentReader } from "./userReader";

/** How long an answer is reused: a turn makes one gateway question, not one per turn of a chat. */
export const EXTRACT_GATE_TTL_MS = 60_000;

export interface DocExtractGate {
	token: string | undefined;
	readerModel?: string | null;
	readerLocal?: boolean;
}

const answers = new Map<string, { at: number; value: DocExtractGate | undefined }>();

/**
 * Whether `doc_extract` is offered for this turn, and the user's own reader: `extractorAvailable`
 * (a gateway read) and `userDocumentReader` (a settings read), kept for a minute per credential.
 */
export async function docExtractGate(
	locals: App.Locals | undefined,
	token: string | undefined
): Promise<DocExtractGate | undefined> {
	const key = token ?? "";
	const hit = token ? answers.get(key) : undefined;
	if (hit && Date.now() - hit.at < EXTRACT_GATE_TTL_MS) return hit.value;
	let value: DocExtractGate | undefined;
	if (await extractorAvailable(token)) {
		const reader = locals ? await userDocumentReader(locals).catch(() => undefined) : undefined;
		value = { token, readerModel: reader?.model, readerLocal: reader?.local };
	}
	// Without a credential there is nothing to key the answer on: it is not kept.
	if (!token) return value;
	if (answers.size > 500) answers.clear();
	answers.set(key, { at: Date.now(), value });
	return value;
}

export function resetDocExtractGate(): void {
	answers.clear();
}
