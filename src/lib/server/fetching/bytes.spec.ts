import { beforeEach, describe, expect, it, vi } from "vitest";

const ssrfSafeFetch = vi.fn();
vi.mock("$lib/server/urlSafety", () => ({
	ssrfSafeFetch,
	isValidUrl: (u: string) => u.startsWith("https://"),
}));
vi.mock("$lib/server/files/extractDocument", async () => {
	// The real allowlist helpers, without the gateway and database the module pulls in.
	return {
		documentMime: (m: string) => m,
		isExtractableDocument: (m: string) => m === "application/pdf",
	};
});

const { fetchDirect } = await import("./direct");

function respond(body: string, contentType: string, url = "https://x.test/f") {
	const response = new Response(body, { headers: { "content-type": contentType } });
	Object.defineProperty(response, "url", { value: url });
	ssrfSafeFetch.mockResolvedValue(response);
}

describe("direct fetch of documents", () => {
	beforeEach(() => vi.resetAllMocks());

	it("returns a PDF as a document with its bytes, not as text", async () => {
		respond("%PDF-1.7\n\u0000\u0001binary", "application/pdf", "https://x.test/pdf/1");
		const page = await fetchDirect("https://x.test/pdf/1");
		expect(page.document).toMatchObject({ mime: "application/pdf", filename: "1.pdf" });
		expect(page.content).toBe("");
	});

	it("recognises a PDF served as application/octet-stream by its bytes", async () => {
		respond("%PDF-1.4\nrest", "application/octet-stream", "https://x.test/download?id=3");
		const page = await fetchDirect("https://x.test/download?id=3");
		expect(page.document?.mime).toBe("application/pdf");
	});

	it("reads an HTML page mislabelled as a PDF as the page it is", async () => {
		respond("<html><title>Oops</title><body>not found</body></html>", "application/pdf");
		const page = await fetchDirect("https://x.test/f");
		expect(page.document).toBeUndefined();
		expect(page.title).toBe("Oops");
	});

	it("still reads an ordinary page as text", async () => {
		respond("<html><title>Hi</title></html>", "text/html; charset=utf-8");
		const page = await fetchDirect("https://x.test/f");
		expect(page).toMatchObject({ title: "Hi", content: "<html><title>Hi</title></html>" });
	});
});
