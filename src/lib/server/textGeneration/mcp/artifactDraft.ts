/**
 * Incremental preview of an `artifact` tool call while its arguments stream
 * in (`runMcpFlow.ts` accumulation loop). Providers stream
 * `delta.tool_calls[].function.arguments` as fragments of one JSON object;
 * this extracts the partial `content` string (plus the short identifying
 * fields) without waiting for the call to complete.
 *
 * It has to handle a chunk cut anywhere: mid-string, mid-escape (`...\\`),
 * or mid-`\u` sequence. Decoding restarts from scratch on every emission, so
 * a truncated tail is simply dropped here and recovered on the next chunk.
 */

export interface ArtifactDraftFields {
	command?: string;
	identifier?: string;
	artifactType?: string;
	title?: string;
	content: string;
	/** True when the `content` string's closing quote has been seen. */
	contentComplete: boolean;
}

/**
 * Decode a (possibly truncated) JSON string body — the characters between the
 * quotes. A trailing lone backslash or partial `\u` escape is dropped; the
 * next chunk re-decodes from scratch, so nothing is lost.
 */
export function decodePartialJsonString(raw: string): string {
	let out = "";
	let i = 0;
	while (i < raw.length) {
		const c = raw[i];
		if (c !== "\\") {
			out += c;
			i += 1;
			continue;
		}
		if (i + 1 >= raw.length) break;
		const e = raw[i + 1];
		switch (e) {
			case '"':
				out += '"';
				i += 2;
				break;
			case "\\":
				out += "\\";
				i += 2;
				break;
			case "/":
				out += "/";
				i += 2;
				break;
			case "b":
				out += "\b";
				i += 2;
				break;
			case "f":
				out += "\f";
				i += 2;
				break;
			case "n":
				out += "\n";
				i += 2;
				break;
			case "r":
				out += "\r";
				i += 2;
				break;
			case "t":
				out += "\t";
				i += 2;
				break;
			case "u": {
				const hex = raw.slice(i + 2, i + 6);
				if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
					i = raw.length;
				} else {
					out += String.fromCharCode(parseInt(hex, 16));
					i += 6;
				}
				break;
			}
			default:
				out += e;
				i += 2;
				break;
		}
	}
	return out;
}

/**
 * Find the string value for `key` in a possibly-truncated JSON object.
 * Returns the raw body (between the quotes) plus whether its closing quote
 * was seen. The first `"key": "` occurrence wins; a key name appearing inside
 * an earlier string value is a known limitation, accepted because the short
 * identifying fields come before `content` in practice.
 */
function rawFieldBody(args: string, key: string): { raw: string; complete: boolean } | null {
	const keyIdx = args.indexOf(`"${key}"`);
	if (keyIdx === -1) return null;
	let i = keyIdx + key.length + 2;
	while (i < args.length && /\s/.test(args[i] ?? "")) i += 1;
	if (args[i] !== ":") return null;
	i += 1;
	while (i < args.length && /\s/.test(args[i] ?? "")) i += 1;
	if (args[i] !== '"') return null;
	i += 1;
	let raw = "";
	while (i < args.length) {
		const c = args[i];
		if (c === "\\") {
			raw += args.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (c === '"') return { raw, complete: true };
		raw += c;
		i += 1;
	}
	return { raw, complete: false };
}

function decodedField(args: string, key: string): { value: string; complete: boolean } | null {
	const found = rawFieldBody(args, key);
	if (!found) return null;
	return { value: decodePartialJsonString(found.raw), complete: found.complete };
}

/**
 * Extract preview fields from the arguments accumulated so far. Returns null
 * when nothing identifying has arrived yet (the caller shows "Writing…").
 */
export function extractArtifactDraft(argsSoFar: string): ArtifactDraftFields | null {
	if (!argsSoFar.includes('"')) return null;
	const command = decodedField(argsSoFar, "command");
	const identifier = decodedField(argsSoFar, "identifier");
	const artifactType = decodedField(argsSoFar, "type");
	const title = decodedField(argsSoFar, "title");
	const content = decodedField(argsSoFar, "content");
	if (!command && !identifier && !artifactType && !title && !content) return null;
	return {
		...(command ? { command: command.value } : {}),
		...(identifier ? { identifier: identifier.value } : {}),
		...(artifactType ? { artifactType: artifactType.value } : {}),
		...(title ? { title: title.value } : {}),
		content: content?.value ?? "",
		contentComplete: content?.complete ?? false,
	};
}
