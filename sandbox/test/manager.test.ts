import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { createApi, tokenMatches } from "../src/manager/api.ts";
import { MemoryAudit } from "../src/manager/audit.ts";
import { ConfigError, loadConfig } from "../src/manager/config.ts";
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
	const call = (method: string, path: string, body?: unknown, auth: string | null = TOKEN) =>
		fetch(base + path, {
			method,
			headers: {
				...(auth ? { Authorization: `Bearer ${auth}` } : {}),
				...(body && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {}),
			},
			body:
				body === undefined
					? undefined
					: Buffer.isBuffer(body)
						? new Uint8Array(body)
						: JSON.stringify(body),
		});
	return { call, close: () => server.close() };
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
			assert.equal(lease.limits.memory_mb, 512);

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
