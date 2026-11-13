/**
 * The chat's side against a real sandbox manager and the real Python exec image (gVisor in CI):
 * `SandboxClient` -> `SandboxSessions` -> manager -> exec daemon. Skipped unless
 * SANDBOX_INTEGRATION_URL (and _TOKEN) point at a running manager whose exec image is
 * cerea-sandbox-python. No external site is ever called: the sandbox has no network.
 */
import { describe, expect, it } from "vitest";
import { SandboxClient } from "$lib/server/sandbox/client";
import { FIGURES_MODULE_SOURCE } from "$lib/utils/execution/figures";
import { SandboxSessions, SANDBOX_RESTARTED_NOTICE, type StageFile } from "./sandboxSessions";

const url = process.env.SANDBOX_INTEGRATION_URL ?? "";
const token = process.env.SANDBOX_INTEGRATION_TOKEN ?? "";

const run = (
	sessions: SandboxSessions,
	code: string,
	files: StageFile[] = [],
	conversationId = "it-conv"
) =>
	sessions.run({
		conversationId,
		owner: "it-user",
		code,
		timeoutSeconds: 30,
		figuresSource: FIGURES_MODULE_SOURCE,
		files,
	});

describe.skipIf(!url)("execute_code on a real server sandbox", () => {
	const client = new SandboxClient({ url, token });

	it("imports numpy, draws a plot, writes files, reads an attachment, and keeps state", async () => {
		const sessions = new SandboxSessions(client);
		try {
			const csv: StageFile = {
				name: "data.csv",
				identity: "hash:1",
				load: async () => new TextEncoder().encode("a,b\n1,2\n3,4\n"),
			};
			const first = await run(
				sessions,
				[
					"import numpy as np",
					"import pandas as pd",
					"import matplotlib.pyplot as plt",
					"df = pd.read_csv('/mnt/data/data.csv')",
					"plt.plot(df['a'], df['b'])",
					"plt.show()",
					"df.to_csv('/mnt/output/out.csv', index=False)",
					"print('mean', float(np.mean(df['b'])))",
					"int(df['b'].sum())",
				].join("\n"),
				[csv]
			);
			expect(first.reply.ok, first.reply.error ?? "").toBe(true);
			expect(first.reply.stdout).toBe("mean 3.0\n");
			expect(first.reply.result).toBe("6");
			// The figure module is the browser's own: plt.show() leaves figure-1.png in the output folder.
			expect(first.outputs.map((o) => o.name).sort()).toEqual(["figure-1.png", "out.csv"]);
			const png = first.outputs.find((o) => o.name === "figure-1.png");
			expect(
				Buffer.from(png?.bytes ?? [])
					.subarray(1, 4)
					.toString("latin1")
			).toBe("PNG");
			const out = first.outputs.find((o) => o.name === "out.csv");
			expect(new TextDecoder().decode(out?.bytes)).toBe("a,b\n1,2\n3,4\n");
			expect(first.notice).toBeUndefined();

			// the same interpreter: df is still there, and nothing is reported twice
			const second = await run(sessions, "len(df)", [csv]);
			expect(second.reply.result).toBe("2");
			expect(second.outputs).toEqual([]);
		} finally {
			await sessions.release("it-conv");
		}
	}, 240_000);

	it("recreates a lost sandbox and says the state is gone", async () => {
		const sessions = new SandboxSessions(client);
		try {
			await run(sessions, "kept = 1", [], "it-conv-2");
			// the manager's idle reaper, by hand
			const lease = await client.lease({ kind: "exec", owner: "it-user", conversation: "probe" });
			await client.release(lease.id, "it-user");
			await sessions.release("it-conv-2");
			const again = await run(sessions, "'kept' in globals()", [], "it-conv-2");
			expect(again.reply.result).toBe("False");
			expect(again.notice).toBe(SANDBOX_RESTARTED_NOTICE);
		} finally {
			await sessions.release("it-conv-2");
		}
	}, 240_000);

	it("stops a runaway loop at the limit and restarts the interpreter", async () => {
		const sessions = new SandboxSessions(client);
		try {
			await run(sessions, "kept = 1", [], "it-conv-3");
			const slow = await sessions.run({
				conversationId: "it-conv-3",
				owner: "it-user",
				code: "while True:\n    pass",
				timeoutSeconds: 2,
				figuresSource: FIGURES_MODULE_SOURCE,
				files: [],
			});
			expect(slow.reply.ok).toBe(false);
			expect(slow.reply.timeout?.seconds).toBe(2);
			expect((await run(sessions, "'kept' in globals()", [], "it-conv-3")).reply.result).toBe(
				"False"
			);
		} finally {
			await sessions.release("it-conv-3");
		}
	}, 240_000);
});
