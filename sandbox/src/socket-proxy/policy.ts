import { isSliceName } from "../shared/slice.ts";
import { LABEL_INSTANCE, LABEL_MANAGED, NAME_PREFIX, isManaged } from "../shared/labels.ts";

/**
 * What the sandbox manager may ask Docker, as a pure decision. Everything not listed is refused.
 * The labels are the second lock: a container the manager did not create (no `cerea.sandbox=1`
 * and this instance's name) cannot be started, stopped, inspected, removed or exec'd into, even
 * by a manager that asks.
 */
export interface PolicyConfig {
	instance: string;
	/** Runtimes a created container may name: `runsc`, and `runc` only in development. */
	runtimes: string[];
	/** The images a sandbox may use (and the only ones that may be pulled). */
	images: string[];
	/**
	 * The one systemd slice a sandbox may be placed under (`SANDBOX_CGROUP_PARENT`), or unset.
	 * When set, every sandbox must name exactly it; when unset, none may name any.
	 */
	cgroupParent?: string;
	/** The most CPUs a sandbox may be given (`SANDBOX_EXEC_MAX_CPUS`): CpuShares stay within 1024 each. Default 2. */
	maxCpus?: number;
}

export interface PolicyDeps {
	/** A container by id or name: its full id and labels, or null when it does not exist. */
	containerInfo(id: string): Promise<{ id: string; labels: Record<string, string> } | null>;
	/** The container an exec instance belongs to, or null. */
	execContainer(execId: string): Promise<string | null>;
}

export type Verdict =
	{ allow: true; path: string } | { allow: false; status: number; reason: string };

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const FULL_ID = /^[a-f0-9]{64}$/;
/** The only tmpfs options the manager writes: a size, a numeric owner and a mode. */
const TMPFS_OPTIONS =
	/^rw,nosuid,nodev,(?:no)?exec,size=\d{1,5}m,uid=\d{1,10},gid=\d{1,10},mode=[0-7]{3,4}$/;
/** The most open files a sandbox may be given. */
const NOFILE_CAP = 65536;
const NUMERIC_USER = /^(\d+)(?::(\d+))?$/;
const deny = (reason: string, status = 403): Verdict => ({ allow: false, status, reason });

const QUERY_KEYS: Record<string, string[]> = {
	list: ["all", "filters"],
	create: ["name"],
	start: [],
	stop: ["t", "signal"],
	kill: ["signal"],
	wait: ["condition"],
	remove: ["force", "v"],
	inspect: [],
	stats: ["stream", "one-shot"],
	exec: [],
	execStart: [],
	execInspect: [],
	imageInspect: [],
	imagePull: ["fromImage", "tag"],
	ping: [],
	version: [],
};

/** Names a route, or null when the endpoint is not one the manager uses. */
export function route(method: string, pathname: string) {
	const p = pathname.replace(/^\/v\d+\.\d+(?=\/)/, "");
	const isGet = method === "GET" || method === "HEAD";
	if (isGet && p === "/_ping") return { name: "ping" };
	if (method === "GET" && p === "/version") return { name: "version" };
	if (method === "GET" && p === "/containers/json") return { name: "list" };
	if (method === "POST" && p === "/containers/create") return { name: "create" };
	if (method === "POST" && p === "/images/create") return { name: "imagePull" };
	let m = /^\/containers\/([^/]+)\/(start|stop|kill|wait|exec)$/.exec(p);
	if (m && method === "POST") return { name: m[2], container: m[1] };
	m = /^\/containers\/([^/]+)$/.exec(p);
	if (m && method === "DELETE") return { name: "remove", container: m[1] };
	m = /^\/containers\/([^/]+)\/(json|stats)$/.exec(p);
	if (m && method === "GET")
		return { name: m[2] === "json" ? "inspect" : "stats", container: m[1] };
	m = /^\/exec\/([^/]+)\/start$/.exec(p);
	if (m && method === "POST") return { name: "execStart", exec: m[1] };
	m = /^\/exec\/([^/]+)\/json$/.exec(p);
	if (m && method === "GET") return { name: "execInspect", exec: m[1] };
	m = /^\/images\/(.+)\/json$/.exec(p);
	if (m && method === "GET") return { name: "imageInspect", image: decodeURIComponent(m[1]) };
	return null;
}

const CREATE_TOP = new Set([
	"Image",
	"Entrypoint",
	"Cmd",
	"User",
	"WorkingDir",
	"Env",
	"Labels",
	"HostConfig",
	"StopTimeout",
]);
const CREATE_HOST = new Set([
	"Runtime",
	"NetworkMode",
	"ReadonlyRootfs",
	"CapDrop",
	"SecurityOpt",
	"Privileged",
	"Init",
	"IpcMode",
	"Memory",
	"MemorySwap",
	"MemoryReservation",
	"CpuShares",
	"CgroupParent",
	"NanoCpus",
	"PidsLimit",
	"Tmpfs",
	"Ulimits",
]);
const TMPFS_PATHS = new Set(["/workspace", "/tmp"]);

/** A create body that asks for less hardening than the manager's own, or anything extra, is refused. */
export function validateCreate(body: unknown, cfg: PolicyConfig): string | null {
	if (typeof body !== "object" || body === null || Array.isArray(body))
		return "the body must be an object";
	const b = body as Record<string, unknown>;
	for (const k of Object.keys(b)) if (!CREATE_TOP.has(k)) return `${k} is not allowed in a sandbox`;
	if (typeof b.Image !== "string" || !cfg.images.includes(b.Image))
		return "the image is not on the allow-list";
	const labels = b.Labels as Record<string, string> | undefined;
	if (!isManaged(labels, cfg.instance)) return "the container must carry the manager's labels";
	const user = typeof b.User === "string" ? b.User : "";
	if (!nonRootUser(user)) return "the user must be a numeric uid:gid, neither of them 0";
	const h = b.HostConfig as Record<string, unknown> | undefined;
	if (typeof h !== "object" || h === null) return "HostConfig is required";
	for (const k of Object.keys(h))
		if (!CREATE_HOST.has(k)) return `HostConfig.${k} is not allowed in a sandbox`;
	if (typeof h.Runtime !== "string" || !cfg.runtimes.includes(h.Runtime))
		return "the runtime is not allowed";
	if (h.NetworkMode !== "none") return "a sandbox has no network";
	if (h.ReadonlyRootfs !== true) return "the root file system must be read-only";
	if (!Array.isArray(h.CapDrop) || !h.CapDrop.includes("ALL"))
		return "all capabilities must be dropped";
	if (h.Privileged !== undefined && h.Privileged !== false) return "privileged is not allowed";
	const opts = h.SecurityOpt;
	if (
		!Array.isArray(opts) ||
		!opts.some((o) => o === "no-new-privileges" || o === "no-new-privileges:true")
	) {
		return "no-new-privileges is required";
	}
	if (opts.some((o) => typeof o !== "string" || !/^no-new-privileges(:true)?$/.test(o))) {
		return "SecurityOpt may only be no-new-privileges";
	}
	if (h.IpcMode !== undefined && h.IpcMode !== "private") return "IpcMode must be private";
	for (const k of ["Memory", "NanoCpus", "PidsLimit"]) {
		if (typeof h[k] !== "number" || (h[k] as number) <= 0) return `${k} must be a positive limit`;
	}
	if (h.MemorySwap !== h.Memory) return "swap must equal memory (none)";
	if (h.MemoryReservation !== undefined) {
		const r = h.MemoryReservation;
		if (!Number.isInteger(r) || (r as number) <= 0 || (r as number) > (h.Memory as number)) {
			return "MemoryReservation must be a positive whole number of bytes, at most Memory";
		}
	}
	if (h.CpuShares !== undefined) {
		const c = h.CpuShares;
		const cap = Math.ceil(1024 * (cfg.maxCpus ?? 2));
		if (!Number.isInteger(c) || (c as number) < 2 || (c as number) > cap) {
			return `CpuShares must be a whole number from 2 to ${cap} (1024 per CPU of the maximum)`;
		}
	}
	const parent = cgroupParentProblem(h.CgroupParent, cfg.cgroupParent);
	if (parent) return parent;
	const tmpfs = h.Tmpfs;
	if (typeof tmpfs !== "object" || tmpfs === null) return "a tmpfs workspace is required";
	for (const [k, opts] of Object.entries(tmpfs)) {
		if (!TMPFS_PATHS.has(k)) return `tmpfs ${k} is not allowed`;
		if (typeof opts !== "string" || !TMPFS_OPTIONS.test(opts)) {
			return `the tmpfs options for ${k} are not the manager's`;
		}
	}
	if (h.Ulimits !== undefined) {
		if (!Array.isArray(h.Ulimits)) return "Ulimits must be a list";
		for (const u of h.Ulimits as Record<string, unknown>[]) {
			const ok =
				u?.Name === "nofile" &&
				Number.isInteger(u.Soft) &&
				Number.isInteger(u.Hard) &&
				(u.Soft as number) > 0 &&
				(u.Soft as number) <= NOFILE_CAP &&
				(u.Hard as number) > 0 &&
				(u.Hard as number) <= NOFILE_CAP &&
				Object.keys(u).every((k) => k === "Name" || k === "Soft" || k === "Hard");
			if (!ok) return `only a nofile ulimit up to ${NOFILE_CAP} is allowed`;
		}
	}
	return null;
}

/**
 * The cgroup parent is the shared hard cap: a sandbox that names another (or none, when the
 * operator configured one) would escape it, or land in a cgroup the operator never chose.
 */
function cgroupParentProblem(asked: unknown, allowed: string | undefined): string | null {
	if (allowed !== undefined && !isSliceName(allowed)) {
		return "the proxy's own cgroup parent is not a valid slice name";
	}
	if (asked === undefined) {
		return allowed === undefined ? null : `CgroupParent must be ${allowed}`;
	}
	if (typeof asked !== "string" || !isSliceName(asked)) {
		return "CgroupParent must be a systemd slice name";
	}
	if (allowed === undefined || asked !== allowed) return "that CgroupParent is not allowed";
	return null;
}

/** `uid` or `uid:gid`, numeric, with neither 0. */
function nonRootUser(user: string): boolean {
	const m = NUMERIC_USER.exec(user);
	return m !== null && Number(m[1]) !== 0 && (m[2] === undefined || Number(m[2]) !== 0);
}

/**
 * An exec start must be a hijack: attached, no TTY. A detached start gets an ordinary reply on a
 * connection that stays open, which is how a second, unchecked request could ride behind it.
 */
export function validateExecStart(body: unknown): string | null {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return "an exec start needs a JSON body";
	}
	const b = body as Record<string, unknown>;
	for (const k of Object.keys(b)) if (k !== "Detach" && k !== "Tty") return `${k} is not allowed`;
	if (b.Detach !== undefined && b.Detach !== false) return "an exec start may not be detached";
	if (b.Tty !== false) return "an exec start must set Tty to false";
	return null;
}

export function validateExecCreate(body: unknown): string | null {
	if (typeof body !== "object" || body === null || Array.isArray(body))
		return "the body must be an object";
	const b = body as Record<string, unknown>;
	const allowed = new Set([
		"AttachStdin",
		"AttachStdout",
		"AttachStderr",
		"Tty",
		"Cmd",
		"Env",
		"User",
		"WorkingDir",
	]);
	for (const k of Object.keys(b)) if (!allowed.has(k)) return `${k} is not allowed in an exec`;
	if (!Array.isArray(b.Cmd) || b.Cmd.some((a) => typeof a !== "string"))
		return "Cmd must be a list of strings";
	if (b.User !== undefined && !(typeof b.User === "string" && nonRootUser(b.User))) {
		return "an exec may not run as uid 0 or gid 0";
	}
	return null;
}

export function rewriteList(query: URLSearchParams, cfg: PolicyConfig): string {
	let filters: Record<string, unknown> = {};
	try {
		const raw = query.get("filters");
		if (raw) filters = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		filters = {};
	}
	const label = Array.isArray(filters.label) ? (filters.label as string[]) : [];
	filters.label = [...label, `${LABEL_MANAGED}=1`, `${LABEL_INSTANCE}=${cfg.instance}`];
	const out = new URLSearchParams();
	if (query.get("all")) out.set("all", query.get("all") as string);
	out.set("filters", JSON.stringify(filters));
	return out.toString();
}

/**
 * Decides one request. `body` is the parsed JSON body (when there is one). On success `path` is
 * the path and query to send to Docker, which the list route rewrites.
 */
export async function authorize(
	method: string,
	rawUrl: string,
	body: unknown,
	cfg: PolicyConfig,
	deps: PolicyDeps
): Promise<Verdict> {
	const url = new URL(rawUrl, "http://docker");
	// The API version prefix is dropped: Docker is always asked for its own current version.
	const pathname = url.pathname.replace(/^\/v\d+\.\d+(?=\/)/, "");
	const r = route(method, pathname);
	if (!r) return deny("endpoint not allowed");
	const keys = QUERY_KEYS[r.name] ?? [];
	for (const k of url.searchParams.keys())
		if (!keys.includes(k)) return deny(`query parameter ${k} not allowed`);
	let target = pathname + url.search;

	if (r.name === "list") target = `${pathname}?${rewriteList(url.searchParams, cfg)}`;
	if (r.name === "create") {
		const name = url.searchParams.get("name") ?? "";
		if (!name.startsWith(NAME_PREFIX) || !ID.test(name))
			return deny(`the container name must start with ${NAME_PREFIX}`);
		const problem = validateCreate(body, cfg);
		if (problem) return deny(problem);
	}
	if (r.name === "imagePull" || r.name === "imageInspect") {
		const ref =
			r.name === "imagePull"
				? imageRef(url.searchParams.get("fromImage") ?? "", url.searchParams.get("tag"))
				: (r as { image: string }).image;
		if (!cfg.images.includes(ref)) return deny("the image is not on the allow-list");
	}

	const container = (r as { container?: string }).container;
	if (container !== undefined) {
		if (!ID.test(container)) return deny("bad container id");
		const info = await deps.containerInfo(container);
		if (!info) return { allow: false, status: 404, reason: "no such container" };
		if (!isManaged(info.labels, cfg.instance) || !FULL_ID.test(info.id)) {
			return deny("not a sandbox manager container");
		}
		// What was checked is what is asked for: the full id Docker reported, never the name or a
		// short prefix the caller sent (a name can be reassigned between the check and the call).
		target = target.replace(`/containers/${container}`, `/containers/${info.id}`);
		if (r.name === "exec") {
			const problem = validateExecCreate(body);
			if (problem) return deny(problem);
		}
	}
	const exec = (r as { exec?: string }).exec;
	if (exec !== undefined) {
		if (!FULL_ID.test(exec)) return deny("bad exec id");
		const owner = await deps.execContainer(exec);
		if (!owner) return { allow: false, status: 404, reason: "no such exec" };
		const info = await deps.containerInfo(owner);
		if (!info || !isManaged(info.labels, cfg.instance)) {
			return deny("not a sandbox manager container");
		}
		if (r.name === "execStart") {
			const problem = validateExecStart(body);
			if (problem) return deny(problem);
		}
	}
	return { allow: true, path: target };
}

function imageRef(from: string, tag: string | null): string {
	if (!tag) return from;
	return `${from}:${tag}`;
}
