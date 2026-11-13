/**
 * Against a real Docker daemon, through the real socket proxy. Off unless SANDBOX_INTEGRATION=1.
 * SANDBOX_RUNTIME=runc with SANDBOX_ALLOW_RUNC=true on a box without gVisor; CI runs it with runsc.
 */
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createApi } from "../src/manager/api.ts";
import { MemoryAudit } from "../src/manager/audit.ts";
import { DEFAULT_EXEC_IMAGE, loadConfig } from "../src/manager/config.ts";
import { DockerClient } from "../src/manager/docker.ts";
import { LeaseManager } from "../src/manager/leases.ts";
import { createProxy } from "../src/socket-proxy/server.ts";

const enabled = process.env.SANDBOX_INTEGRATION === "1";
const runtime = process.env.SANDBOX_RUNTIME || "runsc";
const instance = `it-${process.pid}`;
const TOKEN = "integration-token-0123456789";

describe("sandbox manager against Docker", { skip: !enabled }, () => {
	let proxy: ReturnType<typeof createProxy>;
	let api: ReturnType<typeof createApi>;
	let leases: LeaseManager;
	let base = "";
	const audit = new MemoryAudit();

	// Every lease route names its owner. A create names the body's; the rest, the lease's own.
	const owners = new Map<string, string>();
	const call = async (
		method: string,
		path: string,
		body?: unknown,
		headers: Record<string, string> = {}
	) => {
		const isBuf = Buffer.isBuffer(body);
		const leaseId = /\/v1\/leases\/([0-9a-f]{24})/.exec(path)?.[1];
		const owner =
			(body as { owner?: string } | undefined)?.owner ??
			(leaseId ? owners.get(leaseId) : undefined) ??
			"user-a";
		return fetch(base + path, {
			method,
			headers: {
				Authorization: `Bearer ${TOKEN}`,
				"X-Sandbox-Owner": owner,
				...(body && !isBuf ? { "Content-Type": "application/json" } : {}),
				...headers,
			},
			body: body === undefined ? undefined : isBuf ? new Uint8Array(body) : JSON.stringify(body),
		});
	};

	before(async () => {
		proxy = createProxy(
			{ socketPath: "/var/run/docker.sock" },
			{ instance, runtimes: [runtime], images: [DEFAULT_EXEC_IMAGE] }
		);
		await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
		const proxyPort = (proxy.address() as AddressInfo).port;
		const config = loadConfig({
			SANDBOX_MANAGER_TOKEN: TOKEN,
			SANDBOX_RUNTIME: runtime,
			SANDBOX_ALLOW_RUNC: process.env.SANDBOX_ALLOW_RUNC,
			SANDBOX_INSTANCE: instance,
			SANDBOX_DOCKER_URL: `http://127.0.0.1:${proxyPort}`,
			SANDBOX_AUDIT_LOG: "",
			SANDBOX_MAX_FILE_BYTES: "65536",
			SANDBOX_EXEC_MAX_OUTPUT_BYTES: "4096",
			SANDBOX_EXEC_MAX_OUTPUT_BYTES_CAP: "8192",
			SANDBOX_EXEC_MAX_TIMEOUT_SECONDS: "10",
			SANDBOX_EXEC_TIMEOUT_SECONDS: "5",
		});
		leases = new LeaseManager({ config, docker: new DockerClient(config.docker), audit });
		api = createApi(config, leases);
		await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
		base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
	});

	after(async () => {
		await leases?.shutdown();
		api?.close();
		proxy?.close();
	});

	it(
		"leases an exec sandbox, runs python, moves a file, and releases it",
		{ timeout: 300_000 },
		async () => {
			const created = await call("POST", "/v1/leases", {
				kind: "exec",
				owner: "user-a",
				conversation: "c1",
			});
			assert.equal(created.status, 201, await created.clone().text());
			const lease = (await created.json()) as { id: string };

			const ran = await call("POST", `/v1/leases/${lease.id}/exec`, {
				cmd: ["python", "-c", "print(6*7)"],
			});
			const out = (await ran.json()) as { exit_code: number; stdout: string };
			assert.equal(out.exit_code, 0);
			assert.equal(out.stdout.trim(), "42");

			const put = await call(
				"PUT",
				`/v1/leases/${lease.id}/files/data/hello.txt`,
				Buffer.from("héllo\n")
			);
			assert.equal(put.status, 204);
			const got = await call("GET", `/v1/leases/${lease.id}/files/data/hello.txt`);
			assert.equal(await got.text(), "héllo\n");
			const seen = await call("POST", `/v1/leases/${lease.id}/exec`, {
				command: "cat /workspace/data/hello.txt; id -u",
			});
			assert.match(((await seen.json()) as { stdout: string }).stdout, /héllo\n65534/);

			// no network
			const net = await call("POST", `/v1/leases/${lease.id}/exec`, {
				cmd: ["python", "-c", "import socket;socket.create_connection(('1.1.1.1',53),2)"],
			});
			assert.notEqual(((await net.json()) as { exit_code: number }).exit_code, 0);

			// the flags, from Docker itself
			const name = `cerea-sbx-${lease.id}`;
			const inspect = JSON.parse(
				execFileSync("docker", ["inspect", name], { encoding: "utf8" })
			)[0];
			const h = inspect.HostConfig;
			assert.equal(h.Runtime, runtime);
			assert.equal(h.NetworkMode, "none");
			assert.equal(h.ReadonlyRootfs, true);
			assert.deepEqual(h.CapDrop, ["ALL"]);
			assert.ok(h.SecurityOpt.includes("no-new-privileges"));
			assert.equal(h.Privileged, false);
			assert.equal(h.MemorySwap, h.Memory, "no swap");
			assert.equal(h.IpcMode, "private");
			assert.ok(!h.SecurityOpt.some((o: string) => /unconfined/.test(o)));
			assert.match(h.Tmpfs["/tmp"], /noexec/);
			assert.match(h.Tmpfs["/tmp"], /size=64m/);
			assert.match(h.Tmpfs["/workspace"], /size=256m/);
			assert.deepEqual(
				h.Ulimits.map((u: { Name: string }) => u.Name),
				["nofile"]
			);
			assert.ok(h.Memory > 0 && h.PidsLimit > 0 && h.NanoCpus > 0);
			assert.equal(h.Binds ?? null, null);
			assert.deepEqual(inspect.Mounts, []);
			assert.equal(inspect.Config.User, "65534:65534");
			assert.equal(inspect.Config.Labels["cerea.sandbox"], "1");
			assert.equal(inspect.Config.Labels["cerea.sandbox.owner"], "user-a");

			const rel = await call("DELETE", `/v1/leases/${lease.id}`);
			assert.equal(rel.status, 204);
			assert.equal(
				execFileSync("docker", ["ps", "-aq", "--filter", `name=${name}`], {
					encoding: "utf8",
				}).trim(),
				""
			);
			assert.equal((await call("GET", `/v1/leases/${lease.id}`)).status, 404);
		}
	);

	it(
		"keeps leases apart, refuses traversal, and bounds output and files",
		{ timeout: 300_000 },
		async () => {
			const mk = async (owner: string) =>
				(
					(await (await call("POST", "/v1/leases", { kind: "exec", owner })).json()) as {
						id: string;
					}
				).id;
			const a = await mk("user-a");
			const b = await mk("user-b");
			owners.set(a, "user-a");
			owners.set(b, "user-b");
			assert.equal(
				(await call("PUT", `/v1/leases/${a}/files/secret.txt`, Buffer.from("A-ONLY"))).status,
				204
			);
			assert.equal((await call("GET", `/v1/leases/${b}/files/secret.txt`)).status, 404);
			const peek = await call("POST", `/v1/leases/${b}/exec`, {
				command: "cat /workspace/secret.txt; ls /workspace",
			});
			assert.doesNotMatch(((await peek.json()) as { stdout: string }).stdout, /A-ONLY/);
			// another owner cannot use a's lease id
			assert.equal(
				(await call("GET", `/v1/leases/${a}`, undefined, { "X-Sandbox-Owner": "user-b" })).status,
				404
			);

			for (const bad of ["..%2Fetc%2Fpasswd", "a%2F..%2F..%2Fx", "%2e%2e%2fx"]) {
				const r = await call("GET", `/v1/leases/${a}/files/${bad}`);
				assert.equal(r.status, 400, bad);
			}
			// a symlink out of the workspace
			await call("POST", `/v1/leases/${a}/exec`, { command: "ln -s /etc/passwd /workspace/link" });
			assert.equal((await call("GET", `/v1/leases/${a}/files/link`)).status, 400);

			const big = await call("POST", `/v1/leases/${a}/exec`, { command: "yes x | head -c 100000" });
			const bigOut = (await big.json()) as { stdout: string; truncated: boolean };
			assert.equal(bigOut.truncated, true);
			assert.ok(bigOut.stdout.length <= 4096);
			assert.equal(
				(await call("PUT", `/v1/leases/${a}/files/big`, Buffer.alloc(70_000))).status,
				413
			);

			const slow = await call("POST", `/v1/leases/${a}/exec`, {
				command: "sleep 30",
				timeout_seconds: 2,
			});
			const slowOut = (await slow.json()) as { timed_out: boolean };
			assert.equal(slowOut.timed_out, true);

			await call("DELETE", `/v1/leases/${a}`);
			await call("DELETE", `/v1/leases/${b}`);
		}
	);

	it("the socket proxy refuses what the manager never asks", async () => {
		const port = (proxy.address() as AddressInfo).port;
		const raw = (method: string, path: string, body?: unknown) =>
			fetch(`http://127.0.0.1:${port}${path}`, {
				method,
				body: body === undefined ? undefined : JSON.stringify(body),
				headers: { "Content-Type": "application/json" },
			});
		assert.equal((await raw("GET", "/containers/json")).status, 200);
		assert.equal((await raw("GET", "/info")).status, 403);
		assert.equal(
			(await raw("POST", "/containers/create?name=cerea-sbx-x", { Image: "alpine" })).status,
			403
		);
		// A container of our own making, not ours to the manager: a throwaway with no labels. Never a
		// real container on this box.
		const id = execFileSync(
			"docker",
			["run", "-d", "--network", "none", DEFAULT_EXEC_IMAGE, "sleep", "60"],
			{ encoding: "utf8" }
		).trim();
		try {
			assert.equal((await raw("GET", `/containers/${id}/json`)).status, 403);
			assert.equal((await raw("POST", `/containers/${id}/start`)).status, 403);
			assert.equal((await raw("DELETE", `/containers/${id}?force=true`)).status, 403);
			assert.equal(
				execFileSync("docker", ["ps", "-q", "--filter", `id=${id}`], { encoding: "utf8" }).trim()
					.length > 0,
				true,
				"the refused DELETE left it running"
			);
		} finally {
			execFileSync("docker", ["rm", "-f", id]);
		}
	});
});
