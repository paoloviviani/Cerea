/**
 * The owner saving their own privacy-withheld file: a click mints a one-time
 * token, a GET spends it. Real bucket and database.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { collections, ready } from "$lib/server/database";
import {
	cleanupTestData,
	createTestConversation,
	createTestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { uploadFile } from "$lib/server/files/uploadFile";
import { deleteConversationAttachments } from "$lib/server/files/deleteConversationAttachments";
import { downloadFile } from "$lib/server/files/downloadFile";
import { withholdStoredFile } from "$lib/server/files/withholdRefusedImages";
import type { MessageFile } from "$lib/types/Message";
import { GET, POST } from "./+server";

beforeAll(async () => {
	await ready;
});
afterEach(async () => {
	await collections.withheldDownloadTokens.deleteMany({});
	await cleanupTestData();
});
afterAll(async () => {
	await collections.withheldDownloadTokens.deleteMany({});
});

const SECRET = "the withheld bytes";
const CLICK = {
	"content-type": "application/json",
	"x-cerea-withheld-download": "click",
	"sec-fetch-site": "same-origin",
	"sec-fetch-dest": "empty",
};

async function withheldFile() {
	const { locals } = await createTestUser();
	const conv = await createTestConversation(locals);
	const file = await uploadFile(
		new File([Buffer.from(SECRET)], "private notes.txt", { type: "text/plain" }),
		conv,
		"t"
	);
	await withholdStoredFile(conv._id, file.value, { rule: "no-notes" });
	const record: MessageFile = { ...file, withheld: { rule: "no-notes" } };
	await collections.conversations.updateOne(
		{ _id: conv._id },
		{
			$set: {
				messages: [
					{ id: "m1", from: "user", content: "x", files: [record], createdAt: new Date() },
				] as never,
			},
		}
	);
	return { locals, conv, file };
}

const params = (id: { toString(): string }) => ({ id: id.toString() });

function mint(
	locals: App.Locals,
	convId: { toString(): string },
	sha256: string,
	headers: Record<string, string> = CLICK
) {
	return POST({
		params: params(convId),
		locals,
		request: new Request("http://localhost/x", {
			method: "POST",
			headers,
			body: JSON.stringify({ sha256 }),
		}),
	} as never);
}

function serve(
	locals: App.Locals,
	convId: { toString(): string },
	token: string | null,
	headers: Record<string, string> = {}
) {
	const url = new URL("http://localhost/x");
	if (token !== null) url.searchParams.set("token", token);
	return GET({
		params: params(convId),
		locals,
		url,
		request: new Request(url, { headers }),
	} as never);
}

const tokenOf = async (res: Response) =>
	new URL(((await res.json()) as { url: string }).url, "http://localhost").searchParams.get(
		"token"
	) as string;

describe.sequential("the owner's download of a withheld file", () => {
	it("serves the bytes once, as an attachment the browser cannot render", async () => {
		const { locals, conv, file } = await withheldFile();
		// The ordinary readers still refuse it.
		await expect(downloadFile(file.value, conv._id)).rejects.toMatchObject({ status: 403 });

		const minted = await mint(locals, conv._id, file.value);
		expect(minted.status).toBe(200);
		expect(minted.headers.get("cache-control")).toBe("no-store");
		const token = await tokenOf(minted);

		const res = await serve(locals, conv._id, token, { "sec-fetch-dest": "document" });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(SECRET);
		expect(res.headers.get("content-disposition")).toContain("attachment");
		expect(res.headers.get("content-disposition")).toContain("private notes.txt");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-security-policy")).toContain("sandbox");
	});

	it("refuses a second use of the token", async () => {
		const { locals, conv, file } = await withheldFile();
		const token = await tokenOf(await mint(locals, conv._id, file.value));
		expect((await serve(locals, conv._id, token)).status).toBe(200);
		await expect(serve(locals, conv._id, token)).rejects.toMatchObject({ status: 403 });
	});

	it("refuses an expired token", async () => {
		const { locals, conv, file } = await withheldFile();
		const token = await tokenOf(await mint(locals, conv._id, file.value));
		await collections.withheldDownloadTokens.updateMany(
			{},
			{ $set: { expiresAt: new Date(Date.now() - 1) } }
		);
		await expect(serve(locals, conv._id, token)).rejects.toMatchObject({ status: 403 });
	});

	it("refuses a request with no token, or a made-up one", async () => {
		const { locals, conv } = await withheldFile();
		await expect(serve(locals, conv._id, null)).rejects.toMatchObject({ status: 403 });
		await expect(serve(locals, conv._id, "nope")).rejects.toMatchObject({ status: 403 });
	});

	it("refuses another user's token, and spends it", async () => {
		const { locals, conv, file } = await withheldFile();
		const token = await tokenOf(await mint(locals, conv._id, file.value));
		const other = await createTestUser();
		await expect(serve(other.locals, conv._id, token)).rejects.toMatchObject({ status: 404 });
		// Another user who owns a conversation of their own still cannot use it there.
		const theirs = await createTestConversation(other.locals);
		await expect(serve(other.locals, theirs._id, token)).rejects.toMatchObject({ status: 403 });
		// The owner's token was spent by that attempt.
		await expect(serve(locals, conv._id, token)).rejects.toMatchObject({ status: 403 });
	});

	it("does not let another user mint one", async () => {
		const { conv, file } = await withheldFile();
		const other = await createTestUser();
		await expect(mint(other.locals, conv._id, file.value)).rejects.toMatchObject({ status: 404 });
	});

	it("mints only from a same-origin fetch that carries the click header", async () => {
		const { locals, conv, file } = await withheldFile();
		const noHeader: Record<string, string> = { ...CLICK };
		delete noHeader["x-cerea-withheld-download"];
		await expect(mint(locals, conv._id, file.value, noHeader)).rejects.toMatchObject({
			status: 403,
		});
		await expect(
			mint(locals, conv._id, file.value, { ...CLICK, "sec-fetch-site": "cross-site" })
		).rejects.toMatchObject({ status: 403 });
		const noFetchMeta: Record<string, string> = { ...CLICK };
		delete noFetchMeta["sec-fetch-site"];
		await expect(mint(locals, conv._id, file.value, noFetchMeta)).rejects.toMatchObject({
			status: 403,
		});
		await expect(
			mint(locals, conv._id, file.value, { ...CLICK, origin: "https://evil.example" })
		).rejects.toMatchObject({ status: 403 });
		expect(await collections.withheldDownloadTokens.countDocuments({})).toBe(0);
	});

	it("refuses to be embedded, and refuses a file that is not withheld", async () => {
		const { locals, conv, file } = await withheldFile();
		const token = await tokenOf(await mint(locals, conv._id, file.value));
		await expect(
			serve(locals, conv._id, token, { "sec-fetch-dest": "iframe" })
		).rejects.toMatchObject({ status: 403 });

		const plain = await uploadFile(
			new File([Buffer.from("fine")], "fine.txt", { type: "text/plain" }),
			conv,
			"t"
		);
		await collections.conversations.updateOne(
			{ _id: conv._id },
			{ $push: { "messages.0.files": plain } as never }
		);
		await expect(mint(locals, conv._id, plain.value)).rejects.toMatchObject({ status: 404 });
		await deleteConversationAttachments(conv._id);
	});

	it("stores only a hash of the token", async () => {
		const { locals, conv, file } = await withheldFile();
		const token = await tokenOf(await mint(locals, conv._id, file.value));
		const row = await collections.withheldDownloadTokens.findOne({});
		expect(JSON.stringify(row)).not.toContain(token);
	});
});
