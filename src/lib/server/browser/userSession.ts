/**
 * A browser the user opens themselves on an agent machine (ADR 0116 phase 2a; the owner's UX
 * decision: like the agent terminal, opened on request and used directly, no browse task and no
 * agent to pause). It is a live stream like a task's, `kind: "agent_machine"`, `userOwned`: input
 * is accepted from the start, there is nothing to hand back, and it ends when the user closes it.
 *
 * Mirrors the terminal's model: the device must be the caller's own and paired, one browser per
 * machine at a time (the same lease the browse tasks use), the session is the caller's alone
 * (`liveTaskFor`), and it ends when its lease is lost. A session nobody watches for a while is
 * closed, so an abandoned tab does not hold the machine's browser.
 */
import { ObjectId } from "mongodb";
import { randomUUID } from "node:crypto";
import { collections } from "$lib/server/database";
import type { BrowserRuntime } from "./contract";
import { McpBrowserRuntime, mcpRuntimeCall, mcpRuntimeKeepAlive } from "./runtimeClient";
import { mongoLeaseStore, type Lease, type LeaseStore } from "./lease";
import { liveTaskFor, registerLiveTask, type LiveRuntime, type LiveSessionInfo } from "./liveView";
import { TaskControl } from "./takeover";
import { browserSettings, type BrowserSettings } from "./settings";
import { hostOf, matchesAny } from "./siteRules";

export const USER_BROWSER_IDLE_MS = 15 * 60_000;

export interface UserBrowserDeps {
	leases?: LeaseStore;
	runtimeFor?: (userId: string, deviceId: string) => BrowserRuntime & Partial<LiveRuntime>;
	/** Resolves a paired device of the user; default: the database. */
	device?: (userId: ObjectId, deviceId: string) => Promise<{ name: string } | null>;
	idleMs?: number;
	/** The deployment's site rules; default: the settings. */
	rules?: BrowserSettings["rules"];
}

export type OpenResult =
	| { ok: true; id: string; streamUrl: string; info: LiveSessionInfo }
	| { ok: false; status: 400 | 403 | 404 | 409 | 501 | 502; message: string };

const closers = new Map<string, (reason?: "ended" | "lease_lost") => Promise<void>>();

async function dbDevice(userId: ObjectId, deviceId: string) {
	let _id: ObjectId;
	try {
		_id = new ObjectId(deviceId);
	} catch {
		return null;
	}
	const row = await collections.codeDevices.findOne({ _id, userId, status: "paired" });
	return row ? { name: row.name ?? "Computer" } : null;
}

export async function openUserBrowser(
	user: { id: ObjectId },
	request: { deviceId: string; url?: string },
	deps: UserBrowserDeps = {}
): Promise<OpenResult> {
	const userId = user.id.toString();
	const device = await (deps.device ?? dbDevice)(user.id, request.deviceId);
	if (!device) return { ok: false, status: 404, message: "No such computer." };
	if (request.url !== undefined && !/^https?:\/\//i.test(request.url)) {
		return { ok: false, status: 400, message: "The address must start with http:// or https://." };
	}
	const rules = deps.rules ?? browserSettings().rules;
	if (request.url) {
		const host = hostOf(request.url);
		if (host && matchesAny(host, rules.deny)) {
			return {
				ok: false,
				status: 403,
				message: `${host} is on this deployment's list of sites the browser may not use.`,
			};
		}
	}
	const id = randomUUID();
	const lease: Lease | null = await (deps.leases ?? mongoLeaseStore)
		.acquire(request.deviceId, user.id, `user-browser:${id}`)
		.catch(() => null);
	if (!lease) {
		return { ok: false, status: 409, message: `The browser on ${device.name} is already in use.` };
	}
	const runtime =
		deps.runtimeFor?.(userId, request.deviceId) ??
		new McpBrowserRuntime(
			mcpRuntimeCall({ userId, deviceId: request.deviceId }),
			mcpRuntimeKeepAlive({ userId, deviceId: request.deviceId })
		);
	const live = runtime as BrowserRuntime & Partial<LiveRuntime>;
	const control = new TaskControl(runtime);
	const registration: { stop?: () => void } = {};
	let idle: NodeJS.Timeout | undefined;
	let closed = false;
	const close = async (reason: "ended" | "lease_lost" = "ended") => {
		if (closed) return;
		closed = true;
		clearTimeout(idle);
		closers.delete(id);
		registration.stop?.();
		// Another task now holds the machine's browser: never hand back or end its pages.
		if (reason !== "lease_lost") {
			await runtime.control?.("handback").catch(() => undefined);
			await runtime.endTask().catch(() => undefined);
		}
		await lease.release();
	};
	try {
		if (!control.supported || typeof live.screencast !== "function") {
			throw Object.assign(new Error("old"), { status: 501 });
		}
		// The user has the page from the start: the runtime takes their input, and (there being no
		// agent) nothing waits on a hand-back.
		await control.takeover();
		// A real (blank) page from the start, so frames and input have something to work on; the
		// deny list goes along, as for any page opened here.
		await runtime.open({ url: request.url ?? "about:blank", deny: rules.deny });
	} catch (err) {
		await close();
		const old = (err as { status?: number }).status === 501;
		return {
			ok: false,
			status: old ? 501 : 502,
			message: old
				? "The browser on that computer is too old for this. Update galopin there."
				: "The browser on that computer did not answer.",
		};
	}
	registration.stop = registerLiveTask({
		taskId: id,
		userId,
		deviceId: request.deviceId,
		machineName: device.name,
		kind: "agent_machine",
		userOwned: true,
		runtime: live as LiveRuntime,
		control,
		leaseHeld: () => lease.check(),
		onEnd: (reason) => void close(reason),
	});
	closers.set(id, close);
	const armIdle = () => {
		clearTimeout(idle);
		idle = setTimeout(() => {
			const t = liveTaskFor(id, userId);
			if (!t || t.viewerCount === 0) void close();
			else armIdle();
		}, deps.idleMs ?? USER_BROWSER_IDLE_MS);
		idle.unref?.();
	};
	armIdle();
	const task = liveTaskFor(id, userId);
	return {
		ok: true,
		id,
		streamUrl: `/api/v2/browse/live/${id}`,
		info: (task as NonNullable<typeof task>).info(),
	};
}

/** Closes the caller's own session; false when there is none (or it is not theirs). */
export async function closeUserBrowser(userId: string, id: string): Promise<boolean> {
	if (!liveTaskFor(id, userId)) return false;
	await closers.get(id)?.();
	return true;
}
