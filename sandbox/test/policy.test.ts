import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execContainerSpec } from "../src/manager/spec.ts";
import {
	authorize,
	validateExecCreate,
	type PolicyConfig,
	type PolicyDeps,
} from "../src/socket-proxy/policy.ts";
import { Demuxer, frame } from "../src/shared/dockerStream.ts";
import { testConfig } from "./fakes.ts";

const cfg: PolicyConfig = {
	instance: "unit",
	runtimes: ["runc"],
	images: [testConfig().execImage],
};
const managed = { "cerea.sandbox": "1", "cerea.sandbox.instance": "unit" };
const deps: PolicyDeps = {
	async containerLabels(id) {
		if (id === "mine") return managed;
		if (id === "other") return { ...managed, "cerea.sandbox.instance": "elsewhere" };
		if (id === "plain") return {};
		return null;
	},
	async execContainer(id) {
		return id === "e-mine" ? "mine" : id === "e-plain" ? "plain" : null;
	},
};
const ask = (method: string, url: string, body?: unknown) =>
	authorize(method, url, body, cfg, deps);
const good = () =>
	execContainerSpec(
		testConfig(),
		{ id: "a".repeat(24), owner: "u", kind: "exec" },
		testConfig().defaults
	) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("socket proxy: endpoints", () => {
	it("allows the manager's own calls on a labelled container", async () => {
		for (const [m, u] of [
			["GET", "/containers/mine/json"],
			["POST", "/containers/mine/start"],
			["POST", "/containers/mine/exec"],
			["DELETE", "/containers/mine?force=true&v=true"],
			["GET", "/v1.47/containers/mine/stats?stream=false&one-shot=true"],
			["GET", "/exec/e-mine/json"],
			["POST", "/exec/e-mine/start"],
			["GET", "/_ping"],
		] as const) {
			const body = u.endsWith("/exec") ? { Cmd: ["ls"] } : undefined;
			assert.equal((await ask(m, u, body)).allow, true, `${m} ${u}`);
		}
	});

	it("denies every endpoint the manager does not use", async () => {
		for (const [m, u] of [
			["GET", "/info"],
			["GET", "/containers/mine/logs"],
			["POST", "/containers/mine/update"],
			["POST", "/containers/mine/attach"],
			["POST", "/containers/prune"],
			["GET", "/volumes"],
			["POST", "/volumes/create"],
			["GET", "/networks"],
			["POST", "/networks/create"],
			["POST", "/build"],
			["GET", "/images/json"],
			["DELETE", "/images/alpine"],
			["POST", "/swarm/init"],
			["GET", "/events"],
			["PUT", "/containers/mine/archive"],
			["POST", "/exec/e-mine/resize"],
		] as const) {
			const v = await ask(m, u);
			assert.equal(v.allow, false, `${m} ${u}`);
		}
	});

	it("denies unlabelled containers and another instance's", async () => {
		for (const id of ["plain", "other"]) {
			assert.equal((await ask("GET", `/containers/${id}/json`)).allow, false);
			assert.equal((await ask("POST", `/containers/${id}/start`)).allow, false);
			assert.equal((await ask("DELETE", `/containers/${id}?force=true`)).allow, false);
			assert.equal((await ask("POST", `/containers/${id}/exec`, { Cmd: ["id"] })).allow, false);
		}
		assert.equal((await ask("GET", "/containers/missing/json")).allow, false);
		assert.equal((await ask("POST", "/exec/e-plain/start", { Detach: false })).allow, false);
		assert.equal((await ask("GET", "/exec/e-unknown/json")).allow, false);
	});

	it("rejects extra query parameters", async () => {
		assert.equal((await ask("DELETE", "/containers/mine?link=true")).allow, false);
		assert.equal((await ask("GET", "/containers/json?size=true")).allow, false);
	});

	it("forces the label filter onto a container list", async () => {
		const v = await ask(
			"GET",
			`/containers/json?all=true&filters=${encodeURIComponent('{"label":["x=y"]}')}`
		);
		assert.ok(v.allow);
		const filters = JSON.parse(
			new URL((v as { path: string }).path, "http://d").searchParams.get("filters") as string
		);
		assert.deepEqual(filters.label, ["x=y", "cerea.sandbox=1", "cerea.sandbox.instance=unit"]);
		const bare = await ask("GET", "/containers/json");
		assert.match(decodeURIComponent((bare as { path: string }).path), /cerea\.sandbox=1/);
	});

	it("allows only the configured image to be pulled or inspected", async () => {
		const ref = encodeURIComponent(cfg.images[0]);
		assert.equal((await ask("POST", `/images/create?fromImage=${ref}`)).allow, true);
		assert.equal(
			(await ask("POST", "/images/create?fromImage=evil%2Fminer&tag=latest")).allow,
			false
		);
		assert.equal((await ask("GET", "/images/alpine/json")).allow, false);
	});
});

describe("socket proxy: create bodies", () => {
	const create = (b: unknown, name = "cerea-sbx-abc") =>
		ask("POST", `/containers/create?name=${name}`, b);

	it("allows exactly what the manager builds", async () => {
		assert.equal((await create(good())).allow, true);
	});

	it("requires the sandbox name prefix", async () => {
		assert.equal((await create(good(), "myname")).allow, false);
		assert.equal((await ask("POST", "/containers/create", good())).allow, false);
	});

	it("refuses each way of asking for less", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const mutations: [string, (b: Record<string, any>) => void][] = [
			["host mount", (b) => (b.HostConfig.Binds = ["/:/host"])],
			["privileged", (b) => (b.HostConfig.Privileged = true)],
			["cap add", (b) => (b.HostConfig.CapAdd = ["SYS_ADMIN"])],
			["devices", (b) => (b.HostConfig.Devices = [{ PathOnHost: "/dev/kvm" }])],
			["host network", (b) => (b.HostConfig.NetworkMode = "host")],
			["a network", (b) => (b.HostConfig.NetworkMode = "default")],
			["host pid", (b) => (b.HostConfig.PidMode = "host")],
			["writable root", (b) => (b.HostConfig.ReadonlyRootfs = false)],
			["caps kept", (b) => (b.HostConfig.CapDrop = [])],
			[
				"seccomp off",
				(b) => (b.HostConfig.SecurityOpt = ["no-new-privileges", "seccomp=unconfined"]),
			],
			["no no-new-privileges", (b) => (b.HostConfig.SecurityOpt = [])],
			["unknown runtime", (b) => (b.HostConfig.Runtime = "nvidia")],
			["root user", (b) => (b.User = "0:0")],
			["named root", (b) => (b.User = "root")],
			["other image", (b) => (b.Image = "alpine")],
			["no labels", (b) => (b.Labels = {})],
			["other instance", (b) => (b.Labels["cerea.sandbox.instance"] = "x")],
			["no memory limit", (b) => delete b.HostConfig.Memory],
			["no pid limit", (b) => delete b.HostConfig.PidsLimit],
			["swap", (b) => (b.HostConfig.MemorySwap = -1)],
			["volume tmpfs path", (b) => (b.HostConfig.Tmpfs["/etc"] = "rw")],
			["extra top-level key", (b) => (b.Volumes = { "/x": {} })],
			["mounts", (b) => (b.HostConfig.Mounts = [{ Type: "bind", Source: "/", Target: "/h" }])],
		];
		for (const [what, mutate] of mutations) {
			const b = good();
			mutate(b);
			assert.equal((await create(b)).allow, false, what);
		}
	});

	it("refuses a privileged or root exec", () => {
		assert.ok(validateExecCreate({ Cmd: ["id"], Privileged: true }));
		assert.ok(validateExecCreate({ Cmd: ["id"], User: "root" }));
		assert.ok(validateExecCreate({ Cmd: ["id"], User: "0" }));
		assert.equal(validateExecCreate({ Cmd: ["id"], User: "65534:65534", Env: ["A=b"] }), null);
	});
});

describe("docker stream demux", () => {
	it("splits stdout and stderr across chunk boundaries", () => {
		const d = new Demuxer();
		const all = Buffer.concat([
			frame(1, Buffer.from("out")),
			frame(2, Buffer.from("err")),
			frame(1, Buffer.from("!")),
		]);
		d.push(all.subarray(0, 5));
		d.push(all.subarray(5, 14));
		d.push(all.subarray(14));
		assert.equal(Buffer.concat(d.stdout).toString(), "out!");
		assert.equal(Buffer.concat(d.stderr).toString(), "err");
		assert.equal(d.total, 7);
	});
});
