import { describe, expect, it } from "vitest";
import { SandboxClient, SandboxError } from "./client";

type Call = { url: string; init: RequestInit };

function fakeFetch(reply: (call: Call) => Response) {
	const calls: Call[] = [];
	const impl = (async (url: string, init: RequestInit) => {
		const call = { url, init };
		calls.push(call);
		return reply(call);
	}) as unknown as typeof fetch;
	return {
		calls,
		client: new SandboxClient({ url: "http://m:8080/", token: "secret-token", fetch: impl }),
	};
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const lease = {
	id: "a".repeat(24),
	kind: "exec",
	owner: "u1",
	conversation: null,
	state: "ready",
	limits: null,
};

describe("SandboxClient", () => {
	it("reads the manager's limits with the token, and tolerates missing or null fields", async () => {
		const full = fakeFetch(() =>
			json({ cpus: 0.5, memoryMb: 512, timeoutSeconds: 60, maxLeases: 8, maxLeasesPerOwner: 2 })
		);
		expect(await full.client.limits()).toMatchObject({ cpus: 0.5, memoryMb: 512 });
		expect(full.calls[0].url).toBe("http://m:8080/v1/limits");
		expect((full.calls[0].init.headers as Record<string, string>).Authorization).toBe(
			"Bearer secret-token"
		);
		// An older or thinner manager: fields absent or null still parse.
		const thin = fakeFetch(() => json({ cpus: null }));
		expect(await thin.client.limits()).toEqual({ cpus: null });
		const empty = fakeFetch(() => json({}));
		expect(await empty.client.limits()).toEqual({});
		// A manager without the route answers 404: an error the caller treats as "unknown".
		const old = fakeFetch(() => json({ error: { code: "not_found", message: "no" } }, 404));
		await expect(old.client.limits()).rejects.toMatchObject({ status: 404 });
	});

	it("sends the token, but not for health", async () => {
		const { client, calls } = fakeFetch((c) =>
			c.url.endsWith("/v1/health")
				? json({ status: "ok", runtime: "runsc", machines: null })
				: json(lease, 201)
		);
		expect((await client.health()).runtime).toBe("runsc");
		expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
		await client.lease({ kind: "exec", owner: "u1" });
		expect((calls[1].init.headers as Record<string, string>).Authorization).toBe(
			"Bearer secret-token"
		);
		expect(calls[1].url).toBe("http://m:8080/v1/leases");
	});

	it("accepts nulls in optional fields", async () => {
		const { client } = fakeFetch(() => json(lease));
		const l = await client.status("x".repeat(24), "u1");
		expect(l.conversation).toBeNull();
	});

	it("runs a command and names the owner", async () => {
		const { client, calls } = fakeFetch(() =>
			json({ exit_code: 0, stdout: "42\n", stderr: "", truncated: false, timed_out: false })
		);
		const out = await client.exec(
			"l1",
			{ cmd: ["python", "-c", "print(42)"], timeoutSeconds: 5 },
			"u1"
		);
		expect(out.stdout).toBe("42\n");
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers["X-Sandbox-Owner"]).toBe("u1");
		expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
			cmd: ["python", "-c", "print(42)"],
			timeout_seconds: 5,
		});
	});

	it("encodes each path segment and moves bytes", async () => {
		const { client, calls } = fakeFetch((c) =>
			c.init.method === "GET"
				? new Response(new Uint8Array([1, 2, 3]))
				: new Response(null, { status: 204 })
		);
		await client.putFile("l1", "dir/a b#.txt", new Uint8Array([9]), "u1");
		expect(calls[0].url).toBe("http://m:8080/v1/leases/l1/files/dir/a%20b%23.txt");
		expect([...(await client.getFile("l1", "x/../y", "u1"))]).toEqual([1, 2, 3]);
		expect(calls[1].url).toBe("http://m:8080/v1/leases/l1/files/x/%2E%2E/y");
	});

	it("turns the manager's error into a SandboxError with its code", async () => {
		const { client } = fakeFetch(() =>
			json({ error: { code: "quota_exceeded", message: "full" } }, 429)
		);
		await expect(client.lease({ kind: "exec", owner: "u1" })).rejects.toMatchObject({
			status: 429,
			code: "quota_exceeded",
		});
	});

	it("reports an unreachable manager and a malformed answer", async () => {
		const down = new SandboxClient({
			url: "http://m",
			token: "t",
			fetch: (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		});
		await expect(down.health()).rejects.toMatchObject({ code: "unreachable" });
		const { client } = fakeFetch(() => json({ nonsense: true }));
		await expect(client.status("l1", "u1")).rejects.toBeInstanceOf(SandboxError);
	});
});
