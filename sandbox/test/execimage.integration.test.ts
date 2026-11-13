/**
 * The Python exec image (exec-image/) in a real sandbox, driven the way the chat drives it: one
 * `python /opt/execd/run.py` per call, through the manager and the socket proxy. Off unless
 * SANDBOX_INTEGRATION=1 and SANDBOX_EXEC_IMAGE names a built image. No network is ever used.
 */
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createApi } from "../src/manager/api.ts";
import { MemoryAudit } from "../src/manager/audit.ts";
import { loadConfig } from "../src/manager/config.ts";
import { DockerClient } from "../src/manager/docker.ts";
import { LeaseManager } from "../src/manager/leases.ts";
import { createProxy } from "../src/socket-proxy/server.ts";

const image = process.env.SANDBOX_EXEC_IMAGE ?? "";
const enabled = process.env.SANDBOX_INTEGRATION === "1" && image !== "";
const runtime = process.env.SANDBOX_RUNTIME || "runsc";
const TOKEN = "execimage-token-0123456789";

interface Reply {
	ok: boolean;
	stdout: string;
	stderr: string;
	result: string | null;
	error: string | null;
	files: { path: string; size: number }[];
	timeout: { seconds: number; mountedFiles: string[] } | null;
}

describe("the Python exec image", { skip: !enabled }, () => {
	let proxy: ReturnType<typeof createProxy>;
	let api: ReturnType<typeof createApi>;
	let leases: LeaseManager;
	let base = "";
	let lease = "";

	const call = (method: string, path: string, body?: unknown) =>
		fetch(base + path, {
			method,
			headers: {
				Authorization: `Bearer ${TOKEN}`,
				"X-Sandbox-Owner": "user-a",
				...(body && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {}),
			},
			body:
				body === undefined
					? undefined
					: Buffer.isBuffer(body)
						? new Uint8Array(body)
						: JSON.stringify(body),
		});

	/** One execute_code call, as the chat makes it. */
	const run = async (code: string, timeout = 30): Promise<Reply> => {
		const res = await call("POST", `/v1/leases/${lease}/exec`, {
			cmd: ["python", "/opt/execd/run.py"],
			stdin: JSON.stringify({ code, timeout }),
			timeout_seconds: timeout + 20,
		});
		const out = (await res.json()) as { exit_code: number; stdout: string; stderr: string };
		assert.equal(out.exit_code, 0, out.stderr);
		return JSON.parse(out.stdout.trim().split("\n").pop() as string) as Reply;
	};

	before(async () => {
		proxy = createProxy(
			{ socketPath: "/var/run/docker.sock" },
			{
				instance: `eit-${process.pid}`,
				runtimes: [runtime],
				images: [image],
			}
		);
		await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
		const config = loadConfig({
			SANDBOX_MANAGER_TOKEN: TOKEN,
			SANDBOX_RUNTIME: runtime,
			SANDBOX_ALLOW_RUNC: process.env.SANDBOX_ALLOW_RUNC,
			SANDBOX_INSTANCE: `eit-${process.pid}`,
			SANDBOX_EXEC_IMAGE: image,
			SANDBOX_DOCKER_URL: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
			SANDBOX_AUDIT_LOG: "",
			SANDBOX_EXEC_MEMORY_MB: "1024",
			SANDBOX_EXEC_WORKSPACE_MB: "128",
		});
		leases = new LeaseManager({
			config,
			docker: new DockerClient(config.docker),
			audit: new MemoryAudit(),
		});
		api = createApi(config, leases);
		await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
		base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
		const made = await call("POST", "/v1/leases", { kind: "exec", owner: "user-a" });
		assert.equal(made.status, 201, await made.clone().text());
		lease = ((await made.json()) as { id: string }).id;
	});

	after(async () => {
		await leases?.shutdown();
		api?.close();
		proxy?.close();
	});

	it(
		"runs numpy, keeps state between calls, and answers like Pyodide",
		{ timeout: 240_000 },
		async () => {
			const first = await run(
				"import numpy as np\nx = np.arange(10)\nprint('sum', int(x.sum()))\nint(x.sum())"
			);
			assert.equal(first.ok, true, first.error ?? "");
			assert.equal(first.stdout, "sum 45\n");
			assert.equal(first.result, "45");
			const second = await run("int(x.max()) + 1"); // x survives in the lease's interpreter
			assert.equal(second.result, "10");
			const failed = await run("1 / 0");
			assert.equal(failed.ok, false);
			assert.match(failed.error ?? "", /ZeroDivisionError/);
		}
	);

	it(
		"draws a plot and writes files that come back, and reads a staged input",
		{ timeout: 240_000 },
		async () => {
			const csv = Buffer.from("a,b\n1,2\n3,4\n");
			assert.equal((await call("PUT", `/v1/leases/${lease}/files/data/in.csv`, csv)).status, 204);
			const reply = await run(
				[
					"import matplotlib",
					"matplotlib.use('Agg')",
					"import matplotlib.pyplot as plt",
					"import pandas as pd",
					"df = pd.read_csv('/mnt/data/in.csv')",
					"plt.plot(df['a'], df['b'])",
					"plt.savefig('/mnt/output/plot.png')",
					"df.to_excel('/mnt/output/table.xlsx', index=False)",
					"int(df['b'].sum())",
				].join("\n")
			);
			assert.equal(reply.ok, true, reply.error ?? "");
			assert.equal(reply.result, "6");
			const paths = reply.files.map((f) => f.path).sort();
			assert.deepEqual(paths, ["/mnt/output/plot.png", "/mnt/output/table.xlsx"]);
			const png = await call("GET", `/v1/leases/${lease}/files/output/plot.png`);
			assert.equal(png.status, 200);
			const bytes = Buffer.from(await png.arrayBuffer());
			assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG");
			const xlsx = Buffer.from(
				await (await call("GET", `/v1/leases/${lease}/files/output/table.xlsx`)).arrayBuffer()
			);
			assert.equal(xlsx.subarray(0, 2).toString("latin1"), "PK");
			// not reported again by a run that changes nothing
			assert.deepEqual((await run("1")).files, []);
		}
	);

	it(
		"has no network, and a run past its limit restarts the interpreter",
		{ timeout: 240_000 },
		async () => {
			const net = await run(
				"import socket\ntry:\n    socket.create_connection(('1.1.1.1', 53), 2)\n    r = 'connected'\nexcept OSError:\n    r = 'no network'\nr"
			);
			assert.equal(net.result, "no network");
			await run("kept = 1");
			const slow = await run("while True:\n    pass", 2);
			assert.equal(slow.ok, false);
			assert.equal(slow.timeout?.seconds, 2);
			const after = await run("'kept' in globals()");
			assert.equal(after.result, "False");
		}
	);

	it(
		"kills a run that holds the GIL, which neither signals nor a watchdog thread can stop",
		{ timeout: 240_000 },
		async () => {
			await run("survivor = 1");
			const started = Date.now();
			const stuck = await run("sum(range(10**13))", 2);
			assert.equal(stuck.ok, false);
			assert.equal(stuck.timeout?.seconds, 2);
			// run.py's own deadline (the limit plus a grace) fired, not the manager's backstop.
			assert.ok(Date.now() - started < 45_000, `took ${Date.now() - started} ms`);
			// the daemon was killed with its process group, and the next call starts a fresh one
			const after = await run("'survivor' in globals()");
			assert.equal(after.result, "False");
			// no runaway process is left burning a CPU
			const ps = await call("POST", `/v1/leases/${lease}/exec`, {
				command: "ps -eo args | grep -c 'range(10' || true",
			});
			assert.ok(Number(((await ps.json()) as { stdout: string }).stdout.trim()) <= 1);
		}
	);
});
