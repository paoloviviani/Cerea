import { describe, expect, it } from "vitest";
import { currentTimeLine, gapMarker, isoDateIn } from "./clock";
import { prepareMessagesWithFiles } from "./prepareFiles";
import { resolvePreprompt } from "../preprompt";
import { buildToolPreprompt } from "./toolPrompt";
import type { EndpointMessage } from "$lib/server/endpoints/endpoints";

// 2026-10-03 23:30 in New York is already 2026-10-04 in Rome and Tokyo.
const NOW = new Date("2026-10-04T03:30:00Z");

describe("the current time line", () => {
	it("is in the user's zone, including the date after the zone's midnight", () => {
		expect(currentTimeLine(NOW, "America/New_York")).toBe(
			"Current date and time: Saturday, October 3, 2026 at 11:30 PM (2026-10-03). User's timezone: America/New_York."
		);
		expect(currentTimeLine(NOW, "Asia/Tokyo")).toContain("(2026-10-04)");
		expect(currentTimeLine(NOW, "Asia/Tokyo")).toContain("12:30 PM");
	});

	it("falls back to the server's zone for an unknown one, and claims no zone", () => {
		const line = currentTimeLine(NOW, "Mars/Olympus");
		expect(line).toMatch(/^Current date and time: .* \(\d{4}-\d{2}-\d{2}\)\.$/);
		expect(line).not.toContain("User's timezone");
	});

	it("isoDate follows the zone, not the server's calendar", () => {
		expect(isoDateIn(NOW, "America/New_York")).toBe("2026-10-03");
		expect(isoDateIn(NOW, "Asia/Tokyo")).toBe("2026-10-04");
		expect(isoDateIn(NOW, "Nowhere/Land")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

describe("the system prompt says when it is, once", () => {
	const base = {
		conversationPreprompt: "Be brief.",
		mlAssistant: false,
		timezone: "Asia/Tokyo",
		now: NOW,
	};
	const count = (text: string) => text.split("Current date and time:").length - 1;

	it("with no tools at all", () => {
		const prompt = resolvePreprompt(base) ?? "";
		expect(count(prompt)).toBe(1);
		expect(prompt).toContain("User's timezone: Asia/Tokyo.");
	});

	it("with tools on it is still one line: the tool prompt no longer states it", () => {
		const tools = [{ type: "function", function: { name: "web_search", parameters: {} } }];
		const toolText = buildToolPreprompt(tools as never, "Asia/Tokyo");
		expect(count(toolText)).toBe(0);
		// ...but its search guidance uses today's date in the user's zone.
		expect(toolText).toMatch(/today's date \(\d{4}-\d{2}-\d{2}\) as the end date/);
		expect(count(`${toolText}\n\n${resolvePreprompt({ ...base, supportsTools: true })}`)).toBe(1);
	});

	it("the ML Assistant states it in its session context only", () => {
		const prompt = resolvePreprompt({ ...base, mlAssistant: true, supportsTools: true }) ?? "";
		expect(count(prompt)).toBe(0);
		expect(prompt).toContain("Date=2026-10-04, Time=12:30, Timezone=Asia/Tokyo");
	});
});

describe("gapMarker", () => {
	const at = (iso: string) => new Date(iso);

	it("marks a message sent more than an hour after the one before, in the user's zone", () => {
		expect(gapMarker(at("2026-10-04T09:00:00Z"), at("2026-10-04T12:32:00Z"), "UTC")).toBe(
			"(sent Sun 4 Oct 12:32, 4 hours after the previous message)"
		);
		expect(gapMarker(at("2026-10-01T09:00:00Z"), at("2026-10-04T12:32:00Z"), "Asia/Tokyo")).toBe(
			"(sent Sun 4 Oct 21:32, 3 days after the previous message)"
		);
	});

	it("is silent at or under an hour, and for unusable timestamps", () => {
		expect(gapMarker(at("2026-10-04T09:00:00Z"), at("2026-10-04T10:00:00Z"))).toBeNull();
		expect(gapMarker(at("2026-10-04T09:00:00Z"), at("2026-10-04T09:05:00Z"))).toBeNull();
		expect(gapMarker(undefined, at("2026-10-04T10:00:00Z"))).toBeNull();
		expect(gapMarker(at("2026-10-04T10:00:00Z"), at("2026-10-04T09:00:00Z"))).toBeNull();
		expect(gapMarker("not a date", at("2026-10-04T09:00:00Z"))).toBeNull();
	});
});

describe("the marker in the prepared messages", () => {
	const msg = (from: "user" | "assistant", content: string, iso: string): EndpointMessage => ({
		from,
		content,
		createdAt: new Date(iso),
		updatedAt: new Date(iso),
	});
	const prepare = (messages: EndpointMessage[]) =>
		prepareMessagesWithFiles(messages, (() => Promise.resolve({})) as never, false, {
			timezone: "UTC",
		});

	it("prefixes only a user message after a long gap, never an assistant one, and does not touch the input", async () => {
		const messages = [
			msg("user", "first", "2026-10-04T08:00:00Z"),
			msg("assistant", "reply", "2026-10-04T08:00:05Z"),
			msg("user", "second, quickly", "2026-10-04T08:10:00Z"),
			msg("assistant", "reply two", "2026-10-04T08:10:05Z"),
			msg("user", "third, much later", "2026-10-04T14:32:00Z"),
			msg("assistant", "late reply", "2026-10-04T18:00:00Z"),
		];

		const out = await prepare(messages);

		expect(out.map((m) => m.content)).toEqual([
			"first",
			"reply",
			"second, quickly",
			"reply two",
			"(sent Sun 4 Oct 14:32, 6 hours after the previous message)\nthird, much later",
			"late reply",
		]);
		expect(messages[4].content).toBe("third, much later");
	});

	it("puts it ahead of an attached file's text too", async () => {
		const out = await prepare([
			msg("assistant", "hello", "2026-10-01T08:00:00Z"),
			{
				...msg("user", "see file", "2026-10-04T08:00:00Z"),
				files: [
					{
						type: "base64",
						name: "n.txt",
						mime: "text/plain",
						value: Buffer.from("file body").toString("base64"),
					},
				],
			},
		]);
		const text = out[1].content as string;
		expect(text.startsWith("(sent Sun 4 Oct 08:00, 3 days after the previous message)\n")).toBe(
			true
		);
		expect(text).toContain("file body");
	});

	it("a first message gets none", async () => {
		const out = await prepare([msg("user", "hi", "2026-10-04T08:00:00Z")]);
		expect(out[0].content).toBe("hi");
	});
});
