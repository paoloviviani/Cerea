/**
 * The document reader choice, resolved the same way everywhere it is asked.
 *
 * Two callers need this and must never disagree: the Knowledge screen, which
 * shows an administrator what would be picked with nothing chosen, and
 * `extractDocument.ts`, which actually reads a document with it. A gateway
 * without a reader used to mean an upload silently landing on
 * `mistral-ocr-4.1` (Cortecs) — a paid, rate-limited upstream — because the
 * deployment's own local extractor was hidden from every listing
 * (`GET /v1/models` leaves out every internal-provider model). Pystino's
 * `?include=ocr` (a940516 onward) surfaces it again, flagged `local: true`,
 * and this is where that flag earns its keep.
 *
 * Priority, highest first:
 *
 * 1. **An env value** (`CHAT_OCR_MODEL`, or a direct `CHAT_OCR_BASE_URL`
 *    resolved before this runs) — the operator who named one means it, the
 *    same way a direct endpoint already overrides everything (ADR: see
 *    `extractDocument.ts`'s module docstring). Shown fixed and read-only on
 *    the screen, because there is nothing here to choose between.
 * 2. **The Knowledge screen's own stored choice** — an administrator's
 *    explicit decision, kept until changed.
 * 3. **This deployment's local extractor**, when nothing above named one —
 *    a fresh deployment reads documents out of the box rather than falling
 *    through to whatever upstream OCR model happens to be first and priced.
 * 4. **The first reader in the catalogue**, for a gateway with no local
 *    extractor and no candidate flagged `local`.
 * 5. **None** — nothing to read with, spelled out rather than a silent gap.
 */

export interface ExtractorCandidate {
	id: string;
	/** `ModelCard.local` from `GET /v1/models?include=ocr` — this deployment's
	 * own infrastructure rather than an ordinary catalogue entry. */
	local: boolean;
}

export type ExtractorSource = "env" | "stored" | "local-default" | "first-available" | "none";

export interface ExtractorResolution {
	model: string | null;
	source: ExtractorSource;
}

export function resolveExtractor(options: {
	envModel: string | null;
	storedModel: string | null;
	candidates: ExtractorCandidate[];
}): ExtractorResolution {
	const { envModel, storedModel, candidates } = options;
	if (envModel) return { model: envModel, source: "env" };
	if (storedModel) return { model: storedModel, source: "stored" };
	const local = candidates.find((candidate) => candidate.local);
	if (local) return { model: local.id, source: "local-default" };
	const first = candidates[0];
	if (first) return { model: first.id, source: "first-available" };
	return { model: null, source: "none" };
}
