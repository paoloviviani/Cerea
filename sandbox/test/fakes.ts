import type { ContainerInfo, DockerApi, ExecOptions, ExecResult } from "../src/manager/docker.ts";
import { loadConfig } from "../src/manager/config.ts";

export const TOKEN = "unit-test-token-0123456789";

export function testConfig(extra: Record<string, string> = {}) {
	return loadConfig({
		SANDBOX_MANAGER_TOKEN: TOKEN,
		SANDBOX_RUNTIME: "runc",
		SANDBOX_ALLOW_RUNC: "true",
		SANDBOX_AUDIT_LOG: "",
		SANDBOX_INSTANCE: "unit",
		...extra,
	});
}

/** An in-memory Docker: containers by id, with whatever labels the test gives them. */
export class FakeDocker implements DockerApi {
	containers = new Map<string, ContainerInfo>();
	created: { name: string; spec: Record<string, unknown> }[] = [];
	execs: ExecOptions[] = [];
	removed: string[] = [];
	nextExec: Partial<ExecResult> = {};
	failCreate = false;
	failRemove = false;
	/** When set, an exec / an inspect waits for it. */
	holdExec: Promise<void> | null = null;
	holdInspect: Promise<void> | null = null;
	private n = 0;

	async ensureImage() {}
	async createContainer(name: string, spec: Record<string, unknown>) {
		if (this.failCreate) throw new Error("unknown or invalid runtime name: runsc");
		const id = `c${++this.n}`;
		this.created.push({ name, spec });
		this.containers.set(id, { Id: id, Config: { Labels: spec.Labels as Record<string, string> } });
		return id;
	}
	/** Replaces a container's labels, as if it had lost them. */
	relabel(id: string, labels: Record<string, string>) {
		const c = this.containers.get(id);
		if (c) c.Config = { Labels: labels };
	}
	async start() {}
	async inspect(id: string) {
		if (this.holdInspect) await this.holdInspect;
		return this.containers.get(id) ?? null;
	}
	async remove(id: string) {
		if (this.failRemove) throw new Error("removal of the container is already in progress");
		this.removed.push(id);
		this.containers.delete(id);
	}
	async listManaged(filters: string[]) {
		return [...this.containers.values()].filter((c) =>
			filters.every((f) => {
				const [k, v] = f.split("=");
				return c.Config?.Labels?.[k] === v;
			})
		);
	}
	async cpuSeconds() {
		return 1.5;
	}
	async exec(_id: string, o: ExecOptions): Promise<ExecResult> {
		if (this.holdExec) await this.holdExec;
		this.execs.push(o);
		return {
			exitCode: 0,
			stdout: Buffer.from("ok\n"),
			stderr: Buffer.alloc(0),
			truncated: false,
			timedOut: false,
			stillRunning: false,
			durationMs: 5,
			...this.nextExec,
		};
	}
}
