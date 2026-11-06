import { describe, expect, it } from "vitest";
import { PER_CLASS_DEFAULTS } from "$lib/types/AgentReview";
import {
	classRows,
	expectationLine,
	outcomeText,
	reasonText,
	reviewerFor,
	type AutoSetup,
} from "./autoApproval";

const reviewer: AutoSetup = { reviewerAvailable: true, perClass: PER_CLASS_DEFAULTS };
const outcomes = (setup = reviewer) =>
	Object.fromEntries(classRows(setup).map((r) => [r.class, r.outcome]));

describe("whether a reviewer answers", () => {
	it("needs one available for the user and the device not opted out", () => {
		expect(reviewerFor(reviewer)).toBe(true);
		expect(reviewerFor({ ...reviewer, reviewerAvailable: false })).toBe(false);
		expect(reviewerFor({ ...reviewer, neverReview: true })).toBe(false);
		expect(reviewerFor(null)).toBe(false);
	});
});

describe("the rows of a session on Auto (no machine limits)", () => {
	it("by the user's default rows: edits, web, agents and tools run; commands and outside access are reviewed; secrets and loops come to you", () => {
		expect(outcomes()).toMatchObject({
			edit: "run",
			web: "run",
			agents: "run",
			tools: "run",
			command: "reviewed",
			outside: "reviewed",
			secrets: "you",
			loop: "you",
		});
		expect(expectationLine("studio-laptop", classRows(reviewer))).toBe(
			"Auto on studio-laptop: edits, web, agents and tools run · commands and outside access are reviewed · secrets and loops come to you"
		);
	});

	it("follows the user's row: a class set to you comes to you, one set to runs runs", () => {
		const setup = {
			...reviewer,
			perClass: { ...PER_CLASS_DEFAULTS, command: "you" as const, outside: "run" as const },
		};
		expect(outcomes(setup)).toMatchObject({ command: "you", outside: "run" });
	});

	it("with no reviewer for the deployment or the device, a reviewer row falls back to you, never to run", () => {
		const off = classRows({ ...reviewer, reviewerAvailable: false });
		expect(off.find((r) => r.class === "command")).toMatchObject({
			outcome: "you",
			reason: "deployment",
		});
		const never = classRows({ ...reviewer, neverReview: true });
		expect(never.find((r) => r.class === "command")).toMatchObject({
			outcome: "you",
			reason: "device",
		});
		// The classes that run still run.
		expect(never.find((r) => r.class === "edit")?.outcome).toBe("run");
	});

	it("secrets and loops always come to you, whatever the rows say", () => {
		const setup = { ...reviewer, perClass: { ...PER_CLASS_DEFAULTS, secrets: "run" as const } };
		expect(outcomes(setup)).toMatchObject({ secrets: "you", loop: "you" });
		const loop = classRows(setup).find((r) => r.class === "loop");
		expect(loop && reasonText(loop)).toBe("Always comes to you");
	});

	it("a secrets row on the reviewer is reviewed while a reviewer answers", () => {
		const setup = {
			...reviewer,
			perClass: { ...PER_CLASS_DEFAULTS, secrets: "reviewer" as const },
		};
		expect(outcomes(setup).secrets).toBe("reviewed");
		expect(outcomes({ ...setup, neverReview: true }).secrets).toBe("you");
	});

	it("names no machine limit anywhere in its words", () => {
		for (const row of classRows(reviewer)) {
			expect(`${outcomeText(row)} ${reasonText(row)}`).not.toMatch(/limit|refused|older/i);
		}
	});
});
