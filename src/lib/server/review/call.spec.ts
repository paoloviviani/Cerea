/** The call to POST /v1/decisions against a fake gateway (Pystino's wire shape, ADR 0100). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/config")>();
	return {
		...actual,
		config: new Proxy(actual.config, {
			get: (t, k) => (k === "OPENAI_BASE_URL" ? "http://gateway.test/v1" : Reflect.get(t, k)),
		}),
	};
});

import { askDecisionModel } from "./call";
import type { AskFields } from "./frame";

const fields: AskFields = {
	class: "command",
	tool: "bash",
	title: "t",
	command: "npm test",
	sessionTitle: "s",
	workspace: "/w",
};
const run = () =>
	askDecisionModel({
		token: "tok",
		modelId: "clef-flash",
		instructions: "",
		fields,
		timeoutMs: 200,
	});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("askDecisionModel", () => {
	it("posts the OpenAI-style body with the caller's token and reads answers[0].probability", async () => {
		fetchMock.mockResolvedValue(
			json({ answers: [{ type: "predicate", name: "safe", probability: 0.96 }] })
		);
		expect(await run()).toEqual({ ok: true, probability: 0.96 });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("http://gateway.test/v1/decisions");
		expect(init.headers.Authorization).toBe("Bearer tok");
		const body = JSON.parse(init.body);
		expect(body.model).toBe("clef-flash");
		expect(body.questions[0]).toMatchObject({ type: "predicate", name: "safe" });
		expect(body.input).toContain("npm test");
	});

	it.each([
		[
			"an unknown model (404)",
			() => json({ error: { message: "NotFoundError: Model not found." } }, 404),
			"unreachable",
		],
		["a provider error (502)", () => json({ error: { message: "upstream" } }, 502), "unreachable"],
		["a refusal answer", () => json({ answers: [{ type: "refusal", name: "safe" }] }), "refusal"],
		["no answers", () => json({ answers: [] }), "malformed"],
		[
			"a string probability",
			() => json({ answers: [{ type: "predicate", probability: "0.99" }] }),
			"malformed",
		],
		[
			"a probability above 1",
			() => json({ answers: [{ type: "predicate", probability: 1.5 }] }),
			"malformed",
		],
		[
			"a choice answer",
			() => json({ answers: [{ type: "choice", probability: 0.99 }] }),
			"malformed",
		],
		["not JSON", () => new Response("<html>", { status: 200 }), "unreachable"],
	])("%s is an error, never a probability", async (_n, make, kind) => {
		fetchMock.mockImplementation(async () => make());
		const r = await run();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.kind).toBe(kind);
	});

	it("a network failure and a timeout are errors", async () => {
		fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
		expect((await run()).ok).toBe(false);
		fetchMock.mockImplementationOnce(
			(_u: string, init: RequestInit) =>
				new Promise((_res, rej) => {
					init.signal?.addEventListener("abort", () =>
						rej(Object.assign(new Error("t"), { name: "TimeoutError" }))
					);
				})
		);
		const r = await run();
		expect(r).toMatchObject({ ok: false, detail: "timed out" });
	});
});
