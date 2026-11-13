import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { createApi, tokenMatches } from "../src/manager/api.ts";
import { MemoryAudit } from "../src/manager/audit.ts";
import { ConfigError, loadConfig } from "../src/manager/config.ts";
import { execContainerSpec } from "../src/manager/spec.ts";
import { LeaseManager, type UsageRecord } from "../src/manager/leases.ts";
import { BadPath, workspaceDir, workspacePath } from "../src/manager/paths.ts";
import { HttpError } from "../src/shared/http.ts";
import { FakeDocker, TOKEN, testConfig } from "./fakes.ts";

function setup(extra: Record<string, string> = {}, now = () => Date.now()) {
	const docker = new FakeDocker();
	const audit = new MemoryAudit();
	const usage: UsageRecord[] = [];
	const config = testConfig(extra);
	const leases = new LeaseManager({ config, docker, audit, now, usageSink: (u) => usage.push(u) });
	return { docker, audit, usage, config, leases };
}

async function serve(s: ReturnType<typeof setup>) {
	const server = createApi(s.config, s.leases);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const call = (
		method: string,
		path: string,
		body?: unknown,
		auth: string | null = TOKEN,
		owner: string | null = null
	) =>
		fetch(base + path, {
			method,
			headers: {
				...(auth ? { Authorization: `Bearer ${auth}` } : {}),
				// Every lease route names its owner; a create's must be the body's own.
				...(owner !== null
					? { "X-Sandbox-Owner": owner }
					: typeof (body as { owner?: unknown } | undefined)?.owner === "string"
						? { "X-Sandbox-Owner": (body as { owner: string }).owner }
						: { "X-Sandbox-Owner": "u1" }),
				...(body && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {}),
			},
			body:
				body === undefined
					? undefined
					: Buffer.isBuffer(body)
						? new Uint8Array(body)
						: JSON.stringify(body),
		});
	return { call, base, close: () => server.close() };
}

describe("config", () => {
	it("refuses to start without a token", () => {
		assert.throws(() => loadConfig({}), ConfigError);
		assert.throws(() => loadConfig({ SANDBOX_MANAGER_TOKEN: "short" }), ConfigError);
	});
	it("allows runc only with SANDBOX_ALLOW_RUNC, and no other runtime", () => {
		const base = { SANDBOX_MANAGER_TOKEN: TOKEN };
		assert.equal(loadConfig(base).runtime, "runsc");
		assert.throws(() => loadConfig({ ...base, SANDBOX_RUNTIME: "runc" }), ConfigError);
		assert.equal(
			loadConfig({ ...base, SANDBOX_RUNTIME: "runc", SANDBOX_ALLOW_RUNC: "true" }).runtime,
			"runc"
		);
		assert.throws(
			() => loadConfig({ ...base, SANDBOX_RUNTIME: "kata", SANDBOX_ALLOW_RUNC: "true" }),
			ConfigError
		);
	});
	it("refuses a default above its maximum", () => {
		assert.throws(() => testConfig({ SANDBOX_EXEC_MEMORY_MB: "4096" }), ConfigError);
	});
});

describe("config: the shared budget", () => {
	const small = {
		SANDBOX_TOTAL_MEMORY_MB: "1536",
		SANDBOX_TOTAL_CPUS: "1.5",
		SANDBOX_EXEC_MEMORY_MB: "1024",
		SANDBOX_EXEC_CPUS: "1",
		SANDBOX_EXEC_MEMORY_RESERVATION_MB: "512",
		SANDBOX_EXEC_CPU_RESERVATION: "0.5",
	};
	it("has no total, no cgroup parent and reserves the limit by default", () => {
		const c = testConfig();
		assert.deepEqual(c.totals, { memoryMb: null, cpus: null });
		assert.equal(c.cgroupParent, null);
		assert.deepEqual(c.reservation, { memoryMb: 1024, cpus: 1 });
	});
	it("reads the small-box preset and clamps unset maxima to the totals", () => {
		const c = testConfig(small);
		assert.deepEqual(c.totals, { memoryMb: 1536, cpus: 1.5 });
		assert.deepEqual(c.reservation, { memoryMb: 512, cpus: 0.5 });
		assert.equal(c.maxima.memoryMb, 1536);
		assert.equal(c.maxima.cpus, 1.5);
	});
	it("refuses a reservation above the limit", () => {
		assert.throws(() => testConfig({ SANDBOX_EXEC_MEMORY_RESERVATION_MB: "2000" }), ConfigError);
		assert.throws(() => testConfig({ SANDBOX_EXEC_CPU_RESERVATION: "1.5" }), ConfigError);
	});
	it("refuses a limit above the total", () => {
		assert.throws(() => testConfig({ ...small, SANDBOX_EXEC_MEMORY_MB: "2000" }), /total/);
		assert.throws(() => testConfig({ ...small, SANDBOX_EXEC_MAX_MEMORY_MB: "4096" }), /total/);
		assert.throws(
			() => testConfig({ ...small, SANDBOX_EXEC_MAX_CPUS: "2", SANDBOX_EXEC_CPUS: "1" }),
			/total/
		);
		assert.throws(() => testConfig({ SANDBOX_TOTAL_CPUS: "0.5" }), /total/);
	});
	it("refuses a bad total", () => {
		assert.throws(() => testConfig({ SANDBOX_TOTAL_MEMORY_MB: "abc" }), /must be a number/);
		assert.throws(() => testConfig({ SANDBOX_TOTAL_CPUS: "0" }), /must be a number/);
	});
	it("takes only a systemd slice name as the cgroup parent", () => {
		assert.equal(
			testConfig({ SANDBOX_CGROUP_PARENT: "cerea-sandbox.slice" }).cgroupParent,
			"cerea-sandbox.slice"
		);
		for (const bad of [
			"cerea",
			"/cerea.slice",
			"a/b.slice",
			"..",
			"x.slice/..",
			"a b.slice",
			"-.scope",
		]) {
			assert.throws(() => testConfig({ SANDBOX_CGROUP_PARENT: bad }), ConfigError, bad);
		}
	});
});

describe("paths", () => {
	it("normalises under /workspace", () => {
		assert.equal(workspacePath("a//b/./c.txt"), "/workspace/a/b/c.txt");
		assert.equal(workspacePath("/etc/passwd"), "/workspace/etc/passwd");
		assert.equal(workspaceDir(undefined), "/workspace");
	});
	it("refuses traversal, control characters, backslashes and emptiness", () => {
		for (const bad of [
			"..",
			"a/../b",
			"../x",
			"a\0b",
			"a\\b",
			"a\nb",
			"",
			"/",
			"x".repeat(300),
			"a/".repeat(600),
		]) {
			assert.throws(() => workspacePath(bad), BadPath, JSON.stringify(bad).slice(0, 30));
		}
	});
});

describe("token", () => {
	it("compares in constant time and rejects any mismatch", () => {
		assert.equal(tokenMatches(TOKEN, TOKEN), true);
		assert.equal(tokenMatches(TOKEN + "x", TOKEN), false);
		assert.equal(tokenMatches("", TOKEN), false);
	});
});

describe("API", () => {
	it("answers /v1/limits with the per-sandbox numbers, behind the token, and nothing else", async () => {
		const s = setup({ SANDBOX_EXEC_CPUS: "0.5", SANDBOX_EXEC_MEMORY_MB: "512" });
		const api = await serve(s);
		try {
			assert.equal((await api.call("GET", "/v1/limits", undefined, null)).status, 401);
			assert.equal(
				(await api.call("GET", "/v1/limits", undefined, "wrong-token-0123456789")).status,
				401
			);
			const res = await api.call("GET", "/v1/limits", undefined, TOKEN);
			assert.equal(res.status, 200);
			const body = (await res.json()) as Record<string, unknown>;
			assert.deepEqual(Object.keys(body).sort(), [
				"cpus",
				"maxLeases",
				"maxLeasesPerOwner",
				"memoryMb",
				"timeoutSeconds",
			]);
			for (const v of Object.values(body)) assert.equal(typeof v, "number");
			assert.equal(body.cpus, s.config.defaults.cpus);
			assert.equal(body.memoryMb, s.config.defaults.memoryMb);
			assert.equal(body.cpus, 0.5);
			assert.equal(body.memoryMb, 512);
			const text = JSON.stringify(body);
			assert.ok(!text.includes(TOKEN));
			assert.ok(!text.includes("/"));
		} finally {
			api.close();
		}
	});

	it("answers health without a token and everything else only with one", async () => {
		const api = await serve(setup());
		try {
			assert.equal((await api.call("GET", "/v1/health", undefined, null)).status, 200);
			assert.equal(
				(await api.call("POST", "/v1/leases", { kind: "exec", owner: "u" }, null)).status,
				401
			);
			assert.equal(
				(
					await api.call(
						"POST",
						"/v1/leases",
						{ kind: "exec", owner: "u" },
						"wrong-token-0123456789"
					)
				).status,
				401
			);
			assert.equal(
				(await api.call("GET", "/v1/leases/aaaaaaaaaaaaaaaaaaaaaaaa", undefined, null)).status,
				401
			);
		} finally {
			api.close();
		}
	});

	it("creates, runs, bounds files, and releases", async () => {
		const s = setup({ SANDBOX_MAX_FILE_BYTES: "100" });
		const api = await serve(s);
		try {
			const created = await api.call("POST", "/v1/leases", { kind: "exec", owner: "u1" });
			assert.equal(created.status, 201);
			const lease = (await created.json()) as { id: string; limits: { memory_mb: number } };
			assert.equal(lease.limits.memory_mb, 1024);

			const run = await api.call("POST", `/v1/leases/${lease.id}/exec`, { cmd: ["echo", "hi"] });
			assert.equal(((await run.json()) as { stdout: string }).stdout, "ok\n");
			// the command runs under `timeout`, as the sandbox user
			assert.deepEqual(s.docker.execs[0].cmd.slice(0, 4), ["timeout", "-s", "KILL", "30"]);

			assert.equal(
				(await api.call("PUT", `/v1/leases/${lease.id}/files/big`, Buffer.alloc(101))).status,
				413
			);
			assert.equal((await api.call("GET", `/v1/leases/${lease.id}/files/..%2Fetc`)).status, 400);
			assert.equal(
				(await api.call("POST", `/v1/leases/${lease.id}/exec`, { cmd: ["x"], command: "y" }))
					.status,
				400
			);
			assert.equal(
				(
					await api.call("POST", `/v1/leases/${lease.id}/exec`, {
						command: "x",
						timeout_seconds: 9999,
					})
				).status,
				400
			);
			assert.equal(
				(
					await api.call("POST", `/v1/leases/${lease.id}/exec`, {
						command: "x",
						max_output_bytes: 1e12,
					})
				).status,
				400
			);

			assert.equal((await api.call("DELETE", `/v1/leases/${lease.id}`)).status, 204);
			assert.equal((await api.call("GET", `/v1/leases/${lease.id}`)).status, 404);
		} finally {
			api.close();
		}
	});

	it("requires the owner on every lease route, and equal to the body's on create", async () => {
		const api = await serve(setup());
		try {
			const raw = (method: string, path: string, body?: unknown, owner?: string) =>
				fetch(api.base + path, {
					method,
					headers: {
						Authorization: `Bearer ${TOKEN}`,
						"Content-Type": "application/json",
						...(owner ? { "X-Sandbox-Owner": owner } : {}),
					},
					body: body === undefined ? undefined : JSON.stringify(body),
				});
			const made = { kind: "exec", owner: "alice" };
			assert.equal((await raw("POST", "/v1/leases", made)).status, 400);
			assert.equal((await raw("POST", "/v1/leases", made, "bob")).status, 400);
			const ok = await raw("POST", "/v1/leases", made, "alice");
			assert.equal(ok.status, 201);
			const id = ((await ok.json()) as { id: string }).id;
			for (const [m, path, body] of [
				["GET", `/v1/leases/${id}`],
				["DELETE", `/v1/leases/${id}`],
				["POST", `/v1/leases/${id}/exec`, { command: "x" }],
				["PUT", `/v1/leases/${id}/files/a`, {}],
				["GET", `/v1/leases/${id}/files/a`],
			] as const) {
				const r = await raw(m, path, body);
				assert.equal(r.status, 400, `${m} ${path} without an owner`);
				assert.equal(
					((await r.json()) as { error: { code: string } }).error.code,
					"owner_required"
				);
			}
			assert.equal((await raw("GET", `/v1/leases/${id}`, undefined, "bob")).status, 404);
			assert.equal((await raw("GET", `/v1/leases/${id}`, undefined, "alice")).status, 200);
		} finally {
			api.close();
		}
	});

	it("refuses a non-number max_output_bytes", async () => {
		const api = await serve(setup());
		try {
			const lease = (await (
				await api.call("POST", "/v1/leases", { kind: "exec", owner: "u1" })
			).json()) as { id: string };
			const r = await api.call("POST", `/v1/leases/${lease.id}/exec`, {
				command: "x",
				max_output_bytes: "5",
			});
			assert.equal(r.status, 400);
		} finally {
			api.close();
		}
	});

	it("answers 503 when the in-flight cap is reached, but never to a status read or a release", async () => {
		const s = setup({ SANDBOX_MAX_INFLIGHT: "1" });
		const api = await serve(s);
		let release: () => void = () => {};
		try {
			const lease = (await (
				await api.call("POST", "/v1/leases", { kind: "exec", owner: "u1" })
			).json()) as { id: string };
			s.docker.holdExec = new Promise<void>((r) => (release = r));
			const slow = api.call("POST", `/v1/leases/${lease.id}/exec`, { command: "sleep" });
			await new Promise((r) => setTimeout(r, 100));
			// The cap is full: a second exec is refused, health is not counted...
			const second = await api.call("POST", `/v1/leases/${lease.id}/exec`, { command: "x" });
			assert.equal(second.status, 503);
			assert.equal((await fetch(`${api.base}/v1/health`)).status, 200);
			// ...and a status read and a release still go through, while the exec is held.
			assert.equal((await api.call("GET", `/v1/leases/${lease.id}`)).status, 200);
			assert.equal((await api.call("DELETE", `/v1/leases/${lease.id}`)).status, 204);
			// Release the hold before awaiting the held call.
			release();
			await slow;
		} finally {
			release();
			api.close();
		}
	});

	it("refuses limits above the maxima and bad owners", async () => {
		const api = await serve(setup());
		try {
			const over = await api.call("POST", "/v1/leases", {
				kind: "exec",
				owner: "u",
				limits: { memory_mb: 99999 },
			});
			assert.equal(over.status, 400);
			assert.equal(
				((await over.json()) as { error: { code: string } }).error.code,
				"limit_exceeds_maximum"
			);
			assert.equal(
				(await api.call("POST", "/v1/leases", { kind: "exec", owner: "bad owner;" })).status,
				400
			);
			assert.equal(
				(await api.call("POST", "/v1/leases", { kind: "exec", owner: "u", limits: { nope: 1 } }))
					.status,
				400
			);
		} finally {
			api.close();
		}
	});

	it("refuses machine leases: disabled, then not built", async () => {
		const off = await serve(setup());
		const on = await serve(setup({ SANDBOX_MACHINES_ENABLED: "true" }));
		try {
			assert.equal(
				(await off.call("POST", "/v1/leases", { kind: "machine", owner: "u" })).status,
				403
			);
			assert.equal(
				(await on.call("POST", "/v1/leases", { kind: "machine", owner: "u" })).status,
				501
			);
		} finally {
			off.close();
			on.close();
		}
	});

	it("scopes a lease to its owner when the caller names one", async () => {
		const s = setup();
		const lease = await s.leases.create({ kind: "exec", owner: "alice" });
		assert.throws(() => s.leases.get(lease.id, "bob"), HttpError);
		await assert.rejects(s.leases.exec(lease.id, { command: "x" }, "bob"), HttpError);
	});
});

describe("the shared cap in the create body", () => {
	const spec = (extra: Record<string, string> = {}) => {
		const s = setup(extra);
		return execContainerSpec(s.config, { id: "a", owner: "u", kind: "exec" }, s.config.defaults)
			.HostConfig as Record<string, unknown>;
	};
	it("sets the reservation, the CPU shares and the slice", () => {
		const h = spec({
			SANDBOX_EXEC_MEMORY_RESERVATION_MB: "512",
			SANDBOX_EXEC_CPU_RESERVATION: "0.5",
			SANDBOX_CGROUP_PARENT: "cerea-sandbox.slice",
		});
		assert.equal(h.MemoryReservation, 512 * 1024 * 1024);
		assert.equal(h.CpuShares, 512);
		assert.equal(h.CgroupParent, "cerea-sandbox.slice");
	});
	it("leaves CgroupParent out when none is configured", () => {
		const h = spec();
		assert.equal("CgroupParent" in h, false);
		assert.equal(h.MemoryReservation, h.Memory);
		assert.equal(h.CpuShares, 1024);
	});
});

describe("hardening of what the manager asks Docker for", () => {
	it("creates a labelled, locked-down container with no network", async () => {
		const s = setup();
		await s.leases.create({ kind: "exec", owner: "u", conversation: "c" });
		const { name, spec } = s.docker.created[0];
		assert.match(name, /^cerea-sbx-[0-9a-f]{24}$/);
		const h = spec.HostConfig as Record<string, unknown>;
		assert.equal(h.NetworkMode, "none");
		assert.equal(h.ReadonlyRootfs, true);
		assert.deepEqual(h.CapDrop, ["ALL"]);
		assert.deepEqual(h.SecurityOpt, ["no-new-privileges"]);
		assert.equal(h.Runtime, "runc");
		assert.equal(h.Binds, undefined);
		assert.equal(spec.User, "65534:65534");
		const labels = spec.Labels as Record<string, string>;
		assert.equal(labels["cerea.sandbox"], "1");
		assert.equal(labels["cerea.sandbox.instance"], "unit");
		assert.equal(labels["cerea.sandbox.owner"], "u");
	});

	it("a failed start leaves nothing behind and frees the quota slot", async () => {
		const s = setup({ SANDBOX_MAX_LEASES_PER_OWNER: "1" });
		s.docker.failCreate = true;
		await assert.rejects(s.leases.create({ kind: "exec", owner: "u" }), /could not start/);
		s.docker.failCreate = false;
		await s.leases.create({ kind: "exec", owner: "u" });
	});
});

describe("labels", () => {
	it("refuses to act on a container that lost or never had the label", async () => {
		const s = setup();
		const lease = await s.leases.create({ kind: "exec", owner: "u" });
		s.docker.relabel(lease.containerId as string, {});
		await assert.rejects(
			s.leases.exec(lease.id, { command: "x" }),
			(e: HttpError) => e.status === 403
		);
		assert.equal(s.docker.execs.length, 0);
		await s.leases.release(lease.id);
		assert.deepEqual(s.docker.removed, [], "an unlabelled container is never removed");
	});

	it("refuses another instance's label", async () => {
		const s = setup();
		const lease = await s.leases.create({ kind: "exec", owner: "u" });
		s.docker.relabel(lease.containerId as string, {
			"cerea.sandbox": "1",
			"cerea.sandbox.instance": "other",
			"cerea.sandbox.lease": lease.id,
		});
		await assert.rejects(
			s.leases.exec(lease.id, { command: "x" }),
			(e: HttpError) => e.status === 403
		);
	});
});

describe("quotas and accounting", () => {
	it("caps concurrent leases per owner and overall", async () => {
		const s = setup({ SANDBOX_MAX_LEASES_PER_OWNER: "2", SANDBOX_MAX_LEASES: "3" });
		await s.leases.create({ kind: "exec", owner: "a" });
		await s.leases.create({ kind: "exec", owner: "a" });
		await assert.rejects(
			s.leases.create({ kind: "exec", owner: "a" }),
			(e: HttpError) => e.status === 429
		);
		await s.leases.create({ kind: "exec", owner: "b" });
		await assert.rejects(
			s.leases.create({ kind: "exec", owner: "c" }),
			(e: HttpError) => e.status === 429
		);
	});

	it("refuses a lease when the reservations would pass a total, and frees them on release", async () => {
		const s = setup({
			SANDBOX_TOTAL_MEMORY_MB: "1536",
			SANDBOX_TOTAL_CPUS: "1.5",
			SANDBOX_EXEC_MEMORY_RESERVATION_MB: "512",
			SANDBOX_EXEC_CPU_RESERVATION: "0.5",
			SANDBOX_MAX_LEASES_PER_OWNER: "9",
		});
		const a = await s.leases.create({ kind: "exec", owner: "a" });
		await s.leases.create({ kind: "exec", owner: "b" });
		await s.leases.create({ kind: "exec", owner: "c" });
		await assert.rejects(
			s.leases.create({ kind: "exec", owner: "d" }),
			(e: HttpError) => e.status === 429 && e.code === "quota_exceeded"
		);
		assert.equal(s.docker.created.length, 3);
		assert.ok(s.audit.records.some((r) => JSON.stringify(r).includes("budget_")));
		await s.leases.release(a.id);
		await s.leases.create({ kind: "exec", owner: "d" });
	});

	it("checks memory and CPU separately", async () => {
		const mem = setup({
			SANDBOX_TOTAL_MEMORY_MB: "1024",
			SANDBOX_EXEC_MEMORY_RESERVATION_MB: "600",
		});
		await mem.leases.create({ kind: "exec", owner: "a" });
		await assert.rejects(
			mem.leases.create({ kind: "exec", owner: "b" }),
			(e: HttpError) => e.status === 429 && /memory/.test(e.message)
		);
		const cpu = setup({ SANDBOX_TOTAL_CPUS: "1.5" });
		await cpu.leases.create({ kind: "exec", owner: "a" });
		await assert.rejects(
			cpu.leases.create({ kind: "exec", owner: "b" }),
			(e: HttpError) => e.status === 429 && /CPU/.test(e.message)
		);
	});

	it("counts a request's own smaller limit as its reservation, and has no cap when unset", async () => {
		const s = setup({
			SANDBOX_TOTAL_MEMORY_MB: "1024",
			SANDBOX_EXEC_MEMORY_RESERVATION_MB: "512",
		});
		for (const o of ["a", "b"]) {
			await s.leases.create({ kind: "exec", owner: o, limits: { memoryMb: 256 } });
		}
		assert.equal(s.docker.created.length, 2);
		const free = setup({ SANDBOX_MAX_LEASES: "20", SANDBOX_MAX_LEASES_PER_OWNER: "20" });
		for (let i = 0; i < 12; i++) await free.leases.create({ kind: "exec", owner: "a" });
	});

	it("does not let two concurrent creates both fit the last share", async () => {
		const s = setup({ SANDBOX_TOTAL_MEMORY_MB: "1024", SANDBOX_MAX_LEASES_PER_OWNER: "9" });
		const results = await Promise.allSettled([
			s.leases.create({ kind: "exec", owner: "a" }),
			s.leases.create({ kind: "exec", owner: "b" }),
		]);
		assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
	});

	it("releases a sandbox the kernel killed, so the next call starts fresh", async () => {
		const s = setup({ SANDBOX_TOTAL_MEMORY_MB: "1024" });
		const lease = await s.leases.create({ kind: "exec", owner: "u" });
		s.docker.containers.clear(); // the container is gone
		await assert.rejects(
			s.leases.exec(lease.id, { command: "x" }),
			(e: HttpError) => e.status === 410
		);
		assert.throws(() => s.leases.get(lease.id), HttpError);
		await s.leases.create({ kind: "exec", owner: "u" }); // its share is free again
	});

	it("records exec time and CPU per lease and hands it to the billing seam", async () => {
		const s = setup();
		const lease = await s.leases.create({ kind: "exec", owner: "u" });
		await s.leases.exec(lease.id, { command: "x" });
		await s.leases.exec(lease.id, { command: "y" });
		await s.leases.release(lease.id);
		assert.equal(s.usage.length, 1);
		assert.equal(s.usage[0].execCalls, 2);
		assert.equal(s.usage[0].cpuSeconds, 1.5);
		const rel = s.audit.records.find((r) => r.action === "lease.release");
		assert.equal(rel?.outcome, "success");
		assert.equal(rel?.owner, "u");
	});

	it("audits without a command or file name", async () => {
		const s = setup();
		const lease = await s.leases.create({ kind: "exec", owner: "u" });
		await s.leases.exec(lease.id, { command: "echo SECRET-COMMAND" });
		await s.leases.putFile(lease.id, "secret-name.txt", Buffer.from("x"));
		assert.doesNotMatch(JSON.stringify(s.audit.records), /SECRET-COMMAND|secret-name/);
	});

	it("destroys a sandbox whose command outlives its timeout", async () => {
		const s = setup();
		const lease = await s.leases.create({ kind: "exec", owner: "u" });
		s.docker.nextExec = { stillRunning: true, timedOut: true };
		await s.leases.exec(lease.id, { command: "x" });
		assert.throws(() => s.leases.get(lease.id), HttpError);
		assert.equal(s.docker.removed.length, 1);
	});
});

describe("concurrency", () => {
	it("counts a call against the lease's cap before the first await", async () => {
		const s = setup({ SANDBOX_MAX_CONCURRENT_EXECS: "2" });
		const lease = await s.leases.create({ kind: "exec", owner: "u" });
		let open!: () => void;
		s.docker.holdInspect = new Promise<void>((r) => (open = r));
		const calls = Array.from({ length: 6 }, () =>
			s.leases.exec(lease.id, { command: "x" }).then(
				() => "ok",
				(e: HttpError) => e.status
			)
		);
		// The guard's inspect is still in flight for the first two; the other four are refused now.
		await new Promise((r) => setTimeout(r, 50));
		open();
		const results = await Promise.all(calls);
		assert.equal(results.filter((r) => r === "ok").length, 2);
		assert.equal(results.filter((r) => r === 429).length, 4);
	});
});

describe("idle reaper and orphans", () => {
	it("releases an idle lease, keeps a busy or recent one", async () => {
		let t = 1_000_000;
		const s = setup({ SANDBOX_IDLE_SECONDS: "60" }, () => t);
		const idle = await s.leases.create({ kind: "exec", owner: "a" });
		const fresh = await s.leases.create({ kind: "exec", owner: "b" });
		t += 50_000;
		await s.leases.exec(fresh.id, { command: "x" });
		t += 20_000;
		assert.equal(await s.leases.reap(), 1);
		assert.throws(() => s.leases.get(idle.id), HttpError);
		assert.equal(s.leases.get(fresh.id).id, fresh.id);
		assert.equal(
			s.audit.records.some(
				(r) => r.action === "lease.release" && r.actor === "reaper" && r.detail?.reason === "idle"
			),
			true
		);
	});

	it("releases a lease past its maximum lifetime even if active", async () => {
		let t = 0;
		const s = setup(
			{
				SANDBOX_MAX_LIFETIME_SECONDS: "100",
				SANDBOX_IDLE_SECONDS: "1000",
				SANDBOX_MAX_IDLE_SECONDS: "1000",
			},
			() => t
		);
		const l = await s.leases.create({ kind: "exec", owner: "a" });
		t = 99_000;
		await s.leases.exec(l.id, { command: "x" });
		t = 101_000;
		assert.equal(await s.leases.reap(), 1);
	});

	it("on start removes this instance's labelled containers and nobody else's", async () => {
		const s = setup();
		s.docker.containers.set("mine", {
			Id: "mine",
			Config: { Labels: { "cerea.sandbox": "1", "cerea.sandbox.instance": "unit" } },
		});
		s.docker.containers.set("theirs", {
			Id: "theirs",
			Config: { Labels: { "cerea.sandbox": "1", "cerea.sandbox.instance": "other" } },
		});
		s.docker.containers.set("plain", { Id: "plain", Config: { Labels: {} } });
		assert.equal(await s.leases.sweepOrphans(), 1);
		assert.deepEqual(s.docker.removed, ["mine"]);
	});
});
