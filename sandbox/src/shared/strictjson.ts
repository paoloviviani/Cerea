/**
 * JSON.parse keeps the LAST of a repeated key; Go (Docker) merges repeated objects. A body checked
 * as parsed here and forwarded as written could therefore mean something else to Docker. The proxy
 * refuses repeated keys at any depth and forwards the canonical re-serialisation of what it checked.
 */
export class DuplicateKeyError extends Error {}

/** Parse JSON text; throw `DuplicateKeyError` when any object repeats a key, SyntaxError when it is not JSON. */
export function parseStrictJson(text: string): unknown {
	const value = JSON.parse(text); // the syntax check, and the value
	let i = 0;
	const ws = () => {
		while (i < text.length && " \t\r\n".includes(text[i]!)) i++;
	};
	const str = (): string => {
		const start = i;
		i++; // opening quote
		while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
		i++;
		return JSON.parse(text.slice(start, i)) as string;
	};
	const walk = (): void => {
		ws();
		const c = text[i];
		if (c === "{") {
			i++;
			const seen = new Set<string>();
			ws();
			if (text[i] === "}") return void i++;
			for (;;) {
				ws();
				const key = str();
				if (seen.has(key)) throw new DuplicateKeyError(`the key "${key.slice(0, 40)}" is repeated`);
				seen.add(key);
				ws();
				i++; // colon
				walk();
				ws();
				if (text[i++] === "}") return;
			}
		} else if (c === "[") {
			i++;
			ws();
			if (text[i] === "]") return void i++;
			for (;;) {
				walk();
				ws();
				if (text[i++] === "]") return;
			}
		} else if (c === '"') {
			str();
		} else {
			while (i < text.length && !",]} \t\r\n".includes(text[i]!)) i++;
		}
	};
	walk();
	return value;
}

/** The bytes to forward: exactly what was validated, in one canonical form. */
export function canonicalBody(parsed: unknown): Buffer {
	return Buffer.from(JSON.stringify(parsed), "utf8");
}
