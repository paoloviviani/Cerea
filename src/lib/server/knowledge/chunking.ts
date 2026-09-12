/**
 * Turning a document's text into passages worth embedding.
 *
 * Ported from the gateway's chunking when the store moved here (ADR 0070),
 * algorithm and constants unchanged — the three decisions that carry every
 * retrieval built on top are structural: split at heading boundaries, then
 * paragraphs, then sentences, only then mid-text; prepend the heading path to
 * every stored passage, because a passage retrieved alone has no idea where it
 * came from otherwise; and measure overlap in characters, cut at a word
 * boundary, capped at a third of the chunk size, because beyond that the index
 * is mostly duplicates and retrieval returns the same sentence several times,
 * which looks like a ranking bug and is not.
 */

/** An ATX markdown heading: one to six hashes, a space, then the text. */
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * A sentence end, approximately. Deliberately not a dependency: the failure
 * mode here is a chunk boundary two words off, not a wrong answer. What it
 * must not do is split on a decimal point or an ellipsis.
 */
const SENTENCE_END = /(?<=[.!?])[.!?]*\s+(?=[^\s])/;

/** Below this, a chunk is a fragment: it embeds to noise. */
export const MIN_CHUNK_CHARS = 80;

export interface Chunk {
	ordinal: number;
	text: string;
	headings: string[];
}

interface Section {
	headings: string[];
	body: string;
}

function sections(text: string): Section[] {
	const path: string[] = [];
	let body: string[] = [];
	let current: string[] = [];
	const out: Section[] = [];

	const flush = () => {
		const joined = body.join("\n").trim();
		if (joined) out.push({ headings: current, body: joined });
		body = [];
	};

	for (const line of text.split("\n")) {
		const match = HEADING.exec(line);
		if (match === null) {
			body.push(line);
			continue;
		}
		flush();
		const level = match[1].length;
		const title = match[2].trim();
		// Truncate the path to this heading's depth, then extend. A document
		// that jumps from h1 to h3 must not lose the h1.
		path.splice(level - 1);
		while (path.length < level - 1) path.push("");
		path[level - 1] = title;
		current = path.filter((part) => part);
	}
	flush();
	return out;
}

interface Atom {
	text: string;
	/** Whether this atom begins a new paragraph, which decides the joiner. */
	startsParagraph: boolean;
}

function atoms(body: string, limit: number): Atom[] {
	const out: Atom[] = [];
	for (const raw of body.split(/\n\s*\n/)) {
		const paragraph = raw.trim();
		if (!paragraph) continue;
		let first = true;
		for (const rawSentence of paragraph.split(SENTENCE_END)) {
			let sentence = rawSentence.trim();
			if (!sentence) continue;
			// A single sentence longer than a whole chunk — a table row, a
			// base64 blob. Cut on whitespace where there is any, mid-token
			// only where there is not.
			while (sentence.length > limit) {
				let cut = sentence.lastIndexOf(" ", limit);
				if (cut <= 0) cut = limit;
				out.push({ text: sentence.slice(0, cut).trim(), startsParagraph: first });
				sentence = sentence.slice(cut).trim();
				first = false;
			}
			if (sentence) {
				out.push({ text: sentence, startsParagraph: first });
				first = false;
			}
		}
	}
	return out;
}

function tail(text: string, overlap: number): string {
	if (overlap <= 0 || !text) return "";
	const piece = text.slice(-overlap);
	const space = piece.indexOf(" ");
	return space === -1 ? piece : piece.slice(space + 1);
}

function pack(pieces: Atom[], limit: number, overlap: number): string[] {
	const chunks: string[] = [];
	let current = "";

	for (const atom of pieces) {
		const joiner = atom.startsParagraph ? "\n\n" : " ";
		const candidate = current ? `${current}${joiner}${atom.text}` : atom.text;
		if (candidate.length <= limit || !current) {
			current = candidate;
			continue;
		}
		chunks.push(current);
		let seed = tail(current, overlap);
		if (seed && seed.length + joiner.length + atom.text.length > limit) seed = "";
		current = seed ? `${seed}${joiner}${atom.text}` : atom.text;
	}
	if (current) chunks.push(current);
	return chunks;
}

/** Split extracted markdown into passages, best boundary first. */
export function chunkMarkdown(text: string, chunkChars = 1200, chunkOverlap = 150): Chunk[] {
	if (chunkChars < MIN_CHUNK_CHARS) {
		throw new Error(`chunk_chars must be at least ${MIN_CHUNK_CHARS}`);
	}
	// More overlap than this and the index is mostly duplicates. Clamped
	// rather than refused: an operator setting it high has made a judgement.
	const overlap = Math.max(0, Math.min(chunkOverlap, Math.floor(chunkChars / 3)));

	const bodies: [string[], string][] = [];
	for (const section of sections(text)) {
		const packed = pack(atoms(section.body, chunkChars), chunkChars, overlap);
		packed.forEach((body, index) => {
			// A trailing fragment joins the chunk before it rather than
			// standing alone — but only within its own section, because
			// merging across a heading would attach text to the wrong path.
			const isLast = index === packed.length - 1;
			if (
				isLast &&
				index > 0 &&
				body.length < MIN_CHUNK_CHARS &&
				bodies.length > 0 &&
				JSON.stringify(bodies[bodies.length - 1][0]) === JSON.stringify(section.headings)
			) {
				const [headings, previous] = bodies.pop() as [string[], string];
				bodies.push([headings, `${previous}\n\n${body}`]);
			} else {
				bodies.push([section.headings, body]);
			}
		});
	}

	return bodies.map(([headings, body], ordinal) => {
		const prefix = headings.map((title, depth) => `${"#".repeat(depth + 1)} ${title}\n`).join("");
		return { ordinal, text: prefix ? `${prefix}\n${body}` : body, headings };
	});
}
