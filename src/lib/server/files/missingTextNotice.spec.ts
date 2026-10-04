import { describe, expect, it } from "vitest";
import type { ExtractionFailureKind } from "$lib/types/Message";
import { missingTextNotice } from "./missingTextNotice";

const notice = (kind: ExtractionFailureKind, reason = "the specific reason") =>
	missingTextNotice({ kind, reason });

describe("missingTextNotice", () => {
	it("hints at a scan only when the PDF has no text layer", () => {
		expect(notice("no-text")).toContain("a model that reads images");
		expect(notice("no-text")).toContain("no text layer");
	});

	it.each<ExtractionFailureKind>([
		"empty",
		"no-reader",
		"no-credential",
		"refused",
		"unreachable",
		"unsupported",
	])("never says a %s failure is a scan, and carries the reason", (kind) => {
		const text = notice(kind);
		expect(text).not.toMatch(/scan|OCR model/);
		expect(text).toContain("the specific reason");
		expect(text).toContain("Say so rather than guessing");
	});

	it("tells a refusal from a missing reader from an unreachable one", () => {
		expect(notice("refused")).toMatch(/refused this file/);
		expect(notice("no-reader")).toMatch(/no reader is configured/);
		expect(notice("unreachable")).toMatch(/could not be reached/);
		expect(notice("empty")).toMatch(/no text was found/);
	});

	it("is neutral, not a scan guess, when the failure was never recorded", () => {
		const text = missingTextNotice(undefined);
		expect(text).toContain("reason was not recorded");
		expect(text).not.toMatch(/scan|OCR model/);
	});

	it("keeps a pathological reason from flooding the prompt", () => {
		expect(notice("refused", "x".repeat(5000)).length).toBeLessThan(700);
	});
});
