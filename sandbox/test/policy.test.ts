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
const FULL = (c: string) => c.repeat(64);
const EXEC_MINE = FULL("e");
const EXEC_PLAIN = FULL("f");
const deps: PolicyDeps = {
	async containerInfo(id) {
		if (id === "mine" || id === FULL("a")) return { id: FULL("a"), labels: managed };
		if (id === "other")
			return { id: FULL("b"), labels: { ...managed, "cerea.sandbox.instance": "elsewhere" } };
		if (id === "plain") return { id: FULL("c"), labels: {} };
		return null;
	},
	async execContainer(id) {
		return id === EXEC_MINE ? "mine" : id === EXEC_PLAIN ? "plain" : null;
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
			["GET", `/exec/${EXEC_MINE}/json`],
			["POST", `/exec/${EXEC_MINE}/start`],
			["GET", "/_ping"],
		] as const) {
			const body = u.endsWith("/exec")
				? { Cmd: ["ls"] }
				: u.includes("/exec/") && u.endsWith("/start")
					? { Detach: false, Tty: false }
					: undefined;
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
			["POST", `/exec/${EXEC_MINE}/resize`],
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
		assert.equal(
			(await ask("POST", `/exec/${EXEC_PLAIN}/start`, { Detach: false, Tty: false })).allow,
			false
		);
		assert.equal((await ask("GET", `/exec/${FULL("9")}/json`)).allow, false);
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

	describe("the shared cgroup parent", () => {
		const slice = "cerea-sandbox.slice";
		const withParent = (parent?: string): PolicyConfig => ({ ...cfg, cgroupParent: parent });
		const body = (parent?: string) => {
			const b = execContainerSpec(
				testConfig({ SANDBOX_CGROUP_PARENT: parent ?? "" }),
				{ id: "a".repeat(24), owner: "u", kind: "exec" },
				testConfig().defaults
			) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
			return b;
		};
		const verdict = (b: unknown, c: PolicyConfig) =>
			authorize("POST", "/containers/create?name=cerea-sbx-abc", b, c, deps);

		it("allows exactly the configured slice, with a reservation and shares", async () => {
			assert.equal((await verdict(body(slice), withParent(slice))).allow, true);
			assert.equal(body(slice).HostConfig.CgroupParent, slice);
			assert.ok(body(slice).HostConfig.MemoryReservation > 0);
		});
		it("refuses any other slice, and one when none is configured", async () => {
			for (const asked of [
				"other.slice",
				"cerea-sandbox.slice/x",
				"/cerea-sandbox.slice",
				"system.slice ",
				"",
				"-.slice/../..",
				"cerea-sandbox",
			]) {
				const b = good();
				b.HostConfig.CgroupParent = asked;
				assert.equal((await verdict(b, withParent(slice))).allow, false, asked);
				assert.equal((await verdict(b, withParent(undefined))).allow, false, asked);
			}
			for (const asked of [null, 1, ["cerea-sandbox.slice"], {}]) {
				const b = good();
				b.HostConfig.CgroupParent = asked;
				assert.equal((await verdict(b, withParent(slice))).allow, false, String(asked));
			}
			assert.equal((await verdict(body(slice), withParent(undefined))).allow, false);
		});
		it("requires the slice when one is configured", async () => {
			assert.equal((await verdict(good(), withParent(slice))).allow, false);
		});
		it("refuses a proxy configured with a bad slice name", async () => {
			assert.equal((await verdict(body(slice), withParent("bad/../name.slice"))).allow, false);
		});
		it("bounds the reservation and the shares, and refuses extra keys", async () => {
			const c = withParent(slice);
			const mutations: [string, (h: Record<string, unknown>) => void][] = [
				["reservation above memory", (h) => (h.MemoryReservation = (h.Memory as number) + 1)],
				["zero reservation", (h) => (h.MemoryReservation = 0)],
				["fractional reservation", (h) => (h.MemoryReservation = 1.5)],
				["string reservation", (h) => (h.MemoryReservation = "512m")],
				["one share", (h) => (h.CpuShares = 1)],
				["huge shares", (h) => (h.CpuShares = 1e9)],
				["cpuset", (h) => (h.CpusetCpus = "0")],
				["cpu quota", (h) => (h.CpuQuota = 100000)],
				["oom kill off", (h) => (h.OomKillDisable = true)],
				["cgroupns host", (h) => (h.CgroupnsMode = "host")],
			];
			for (const [what, mutate] of mutations) {
				const b = body(slice);
				mutate(b.HostConfig);
				assert.equal((await verdict(b, c)).allow, false, what);
			}
		});
	});

	it("refuses a privileged or root exec", () => {
		assert.ok(validateExecCreate({ Cmd: ["id"], Privileged: true }));
		assert.ok(validateExecCreate({ Cmd: ["id"], User: "root" }));
		assert.ok(validateExecCreate({ Cmd: ["id"], User: "0" }));
		assert.equal(validateExecCreate({ Cmd: ["id"], User: "65534:65534", Env: ["A=b"] }), null);
	});
});

describe("socket proxy: hijack, ids and version", () => {
	const start = (body: unknown) => ask("POST", `/exec/${EXEC_MINE}/start`, body);

	it("allows an exec start only attached and without a TTY", async () => {
		assert.equal((await start({ Detach: false, Tty: false })).allow, true);
		assert.equal((await start({ Tty: false })).allow, true);
		for (const bad of [
			{ Detach: true, Tty: false },
			{ Detach: true },
			{ Detach: "false", Tty: false },
			{ Detach: false },
			{ Tty: true },
			{ Tty: false, ConsoleSize: [1, 1] },
			undefined,
			[],
		]) {
			assert.equal((await start(bad)).allow, false, JSON.stringify(bad));
		}
	});

	it("asks Docker for the full id it checked, never the name or a prefix", async () => {
		const v = await ask("GET", "/containers/mine/json");
		assert.deepEqual(v, { allow: true, path: `/containers/${FULL("a")}/json` });
		const d = await ask("DELETE", "/containers/mine?force=true");
		assert.equal((d as { path: string }).path, `/containers/${FULL("a")}?force=true`);
	});

	it("takes a full exec id only", async () => {
		assert.equal((await ask("GET", "/exec/abc123/json")).allow, false);
		assert.equal((await ask("GET", `/exec/${EXEC_MINE}/json`)).allow, true);
	});

	it("drops the API version prefix", async () => {
		const v = await ask("GET", "/v1.12/containers/json");
		assert.ok(v.allow);
		assert.match((v as { path: string }).path, /^\/containers\/json\?/);
	});

	it("refuses tmpfs options and ulimits the manager does not write", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const mutations: [string, (b: Record<string, any>) => void][] = [
			[
				"suid",
				(b) =>
					(b.HostConfig.Tmpfs["/tmp"] = "rw,suid,dev,exec,size=64m,uid=65534,gid=65534,mode=1777"),
			],
			["extra option", (b) => (b.HostConfig.Tmpfs["/workspace"] += ",bind")],
			[
				"huge size",
				(b) =>
					(b.HostConfig.Tmpfs["/tmp"] =
						"rw,nosuid,nodev,noexec,size=99999999m,uid=1,gid=1,mode=0700"),
			],
			["not a string", (b) => (b.HostConfig.Tmpfs["/tmp"] = 5)],
			["nproc ulimit", (b) => (b.HostConfig.Ulimits = [{ Name: "nproc", Soft: 1, Hard: 1 }])],
			[
				"nofile too high",
				(b) => (b.HostConfig.Ulimits = [{ Name: "nofile", Soft: 1, Hard: 10_000_000 }]),
			],
			["gid 0", (b) => (b.User = "65534:0")],
		];
		for (const [what, mutate] of mutations) {
			const b = good();
			mutate(b);
			assert.equal(
				(await ask("POST", "/containers/create?name=cerea-sbx-abc", b)).allow,
				false,
				what
			);
		}
		assert.equal(validateExecCreate({ Cmd: ["id"], User: "65534:0" }) !== null, true);
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
