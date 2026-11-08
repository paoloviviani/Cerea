/** The admin Knowledge page: prefix inputs and the preset helper. */
import { afterEach, describe, expect, it, vi } from "vitest";

import Knowledge from "./knowledge/+page.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const status = (model: string, extra: object = {}) => ({
	enabled: true,
	ready: true,
	embedding_model: model,
	passage_prefix: "",
	query_prefix: "",
	extractor_model: "ocr-1",
	extractor_source: "env",
	vector_store: "pg",
	chunk_chars: 1200,
	chunk_overlap: 150,
	max_upload_bytes: 1000,
	source: "console",
	propagation_seconds: 0,
	detail: null,
	available_embedding_models: [model],
	available_extractor_models: [],
	bases: [],
	stale_base_count: 0,
	history: [],
	...extra,
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

const form = () => document.querySelector("form") as HTMLFormElement;
const input = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLInputElement;

describe("embedding prefixes", () => {
	it("fills the e5 preset only when asked, then saves both prefixes", async () => {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
			Response.json(
				init?.method === "PUT"
					? status("intfloat/multilingual-e5-small", {
							passage_prefix: "passage: ",
							query_prefix: "query: ",
						})
					: status("intfloat/multilingual-e5-small")
			)
		);
		vi.stubGlobal("fetch", fetchMock);
		renderWithApp(Knowledge, {});
		await vi.waitFor(() => expect(input("query-prefix")).toBeTruthy());
		expect(input("query-prefix").value).toBe("");
		expect(input("passage-prefix").value).toBe("");

		(document.querySelector('[data-testid="prefix-preset"]') as HTMLButtonElement).click();
		await vi.waitFor(() => expect(input("query-prefix").value).toBe("query: "));
		expect(input("passage-prefix").value).toBe("passage: ");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		form().requestSubmit();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		const put = fetchMock.mock.calls[1];
		expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({
			query_prefix: "query: ",
			passage_prefix: "passage: ",
		});
	});

	it("leaves the helper disabled for an unknown model", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(status("text-embedding-3-small")))
		);
		renderWithApp(Knowledge, {});
		await vi.waitFor(() => expect(input("query-prefix")).toBeTruthy());
		const button = document.querySelector('[data-testid="prefix-preset"]') as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		button.click();
		expect(input("query-prefix").value).toBe("");
	});

	it("refuses an over-long prefix without sending it", async () => {
		const fetchMock = vi.fn(async () => Response.json(status("m")));
		vi.stubGlobal("fetch", fetchMock);
		renderWithApp(Knowledge, {});
		await vi.waitFor(() => expect(input("query-prefix")).toBeTruthy());
		const field = input("query-prefix");
		field.value = "x".repeat(201);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		await vi.waitFor(() => expect(document.body.textContent).toContain("At most 200"));
		form().requestSubmit();
		await new Promise((r) => setTimeout(r, 50));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
