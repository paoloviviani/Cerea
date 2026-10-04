import type { MessageFile } from "$lib/types/Message";

/** A reason is one sentence for a person; a pathological one must not flood the prompt. */
const MAX_REASON_CHARS = 500;

/**
 * The sentence the model gets in place of a document whose text could not be
 * read — worded from what actually went wrong, because the one fixed
 * sentence this replaces ("it is probably a scan; it needs an OCR model")
 * was told to the model, and through it the person, for a `.docx` that had
 * never been near a scanner.
 *
 * Only a PDF with no text layer (`no-text`) earns the scan hint. A file whose
 * failure was not recorded (stored before the reason was kept) gets a
 * neutral sentence rather than a guess.
 */
export function missingTextNotice(error: MessageFile["extractionError"]): string {
	const say = "Say so rather than guessing at its contents.";
	if (!error) {
		return `No text could be read from this document, and the reason was not recorded. ${say}`;
	}
	const reason = error.reason.trim().slice(0, MAX_REASON_CHARS);
	switch (error.kind) {
		case "no-text":
			return (
				`No text could be read from this document: it has no text layer. ` +
				`${say} If it is a scan, it needs an OCR model rather than the built-in extractor.`
			);
		case "empty":
			return `This document was read but no text was found in it. ${reason} ${say}`;
		case "no-reader":
			return `This document could not be read because no reader is configured for it. ${reason} ${say}`;
		case "no-credential":
			return `This document could not be read because the session has no credential for the document reader. ${reason} ${say}`;
		case "refused":
			return `The document reader refused this file: ${reason} ${say}`;
		case "unreachable":
			return `This document could not be read because the document reader could not be reached. ${reason} ${say}`;
		case "unsupported":
			return `This document's format or size is not supported by the configured reader. ${reason} ${say}`;
	}
}
