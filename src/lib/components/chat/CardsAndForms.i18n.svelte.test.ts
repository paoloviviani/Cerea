/**
 * The chat's question and approval cards in the `en-XA` pseudo-locale: every
 * word on them comes from the catalogue. The model's own text (a question, an
 * option, a tool name, a server) is data and is allowed through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";

import AskQuestion from "./AskQuestion.svelte";
import ElicitationForm from "./ElicitationForm.svelte";
import ToolApprovalCard from "./ToolApprovalCard.svelte";
import type { ElicitationField, ElicitationRequestPayload } from "$lib/types/McpElicitation";
import { unbracketedWords, useEnglish, usePseudoLocale } from "../__tests__/enXaManage";

vi.mock("$lib/utils/sendElicitationAnswer", () => ({
	sendElicitationAnswer: async () => ({ ok: true }),
}));

const DATA = new Set([
	"Postgres",
	"Mongo",
	"Which database?",
	"Relational.",
	"Document.",
	"Pick one.",
	"Name",
	"session_spawn",
	"Migration review",
	"Prompt body",
	"plan",
	"Name *",
]);
// The card's raw arguments are JSON the agent wrote, not words of ours.
const stray = () =>
	unbracketedWords([
		...[...DATA].map((word) => new RegExp(`^${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)),
		/^["{}[\]]/,
	]);

const select = (name: string): ElicitationField =>
	({
		kind: "select",
		name,
		title: name,
		description: "Which database?",
		required: true,
		multiple: false,
		allowOther: true,
		options: [
			{ value: "Postgres", label: "Postgres", description: "Relational." },
			{ value: "Mongo", label: "Mongo", description: "Document." },
		],
	}) as ElicitationField;

const request = (fields: ElicitationField[], source?: "assistant"): ElicitationRequestPayload => ({
	elicitationId: "11111111-1111-4111-8111-111111111111",
	...(source ? { source } : {}),
	server: "Mock",
	mode: "form",
	message: "Pick one.",
	fields,
});

beforeEach(() => {
	usePseudoLocale();
	vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
});
afterEach(() => {
	useEnglish();
	vi.unstubAllGlobals();
});

describe("chat cards, in the pseudo-locale", () => {
	it("a question from the assistant", async () => {
		const screen = render(AskQuestion, {
			conversationId: "abc",
			request: request([select("one"), select("two")], "assistant"),
		});
		await expect.element(screen.getByText("Postgres").first()).toBeVisible();
		expect(stray()).toEqual([]);
	});

	it("a question from a connector", async () => {
		const screen = render(ElicitationForm, {
			conversationId: "abc",
			request: request([
				{
					kind: "text",
					name: "Name",
					title: "Name",
					required: true,
				} as unknown as ElicitationField,
				select("db"),
			]),
		});
		await expect.element(screen.getByText("Pick one.")).toBeVisible();
		expect(stray()).toEqual([]);
	});

	it("an approval card for an agent's action", async () => {
		const screen = render(ToolApprovalCard, {
			conversationId: "abc",
			expiresAt: Date.now() + 90_000,
			request: {
				elicitationId: "gp_1",
				server: "session_spawn",
				mode: "form",
				message: "irrelevant",
				toolApproval: {
					tool: "session_spawn",
					args: {
						galopin: true,
						title: "Migration review",
						modeId: "plan",
						modelId: null,
						workspaceId: "w1",
						prompt: "Prompt body",
					},
				},
			} as ElicitationRequestPayload,
		});
		await expect.element(screen.getByText("Migration review")).toBeVisible();
		expect(stray()).toEqual([]);
	});
});
