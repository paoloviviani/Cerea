/**
 * The whole surface between the local UI renderer and the main process. The preload exposes
 * exactly these channels; the main process validates every argument again (`validate*`), because a
 * compromised renderer is the case this exists for.
 */

export const TOOLS = ["opencode", "goose", "vibe", "claude"] as const;
export type Tool = (typeof TOOLS)[number];
export const ENGINES = ["opencode", "goose", "vibe"] as const;
export type Engine = (typeof ENGINES)[number];

/** One-way calls the renderer may make, by channel; the value is the validated argument. */
export interface Calls {
	"server:probe": { address: string };
	"server:set": { address: string };
	"server:switch": { address: string; confirm: true };
	"server:get": undefined;
	"galopin:status": undefined;
	"galopin:pair": PairOptions;
	"galopin:start": undefined;
	"galopin:stop": undefined;
	"galopin:launch": { tool: Tool; dir?: string };
	"galopin:setup": { tool: Tool; remove: boolean; makeDefault: boolean };
	"galopin:upgrade": { show: boolean };
	"galopin:service": { action: "install" | "uninstall" | "status" };
	"galopin:browser-setup": undefined;
	"galopin:edit-connectors": undefined;
	"galopin:logs": undefined;
	"browser:layout": {
		x: number;
		y: number;
		width: number;
		height: number;
		visible: boolean;
		sideWidth: number;
	};
	"browser:open": { url: string };
	"browser:tab": { action: "activate" | "close"; id: string };
	"browser:nav": { action: "back" | "forward" | "reload" };
	"browser:control": { mode: "agent" | "user" };
	"app:open-cerea": undefined;
	"app:state": undefined;
}
export type Channel = keyof Calls;

export interface PairOptions {
	/** Coding-agent computer (false: connectors only, the default, like the Mac connector app). */
	agent: boolean;
	engine?: Engine;
	flow?: "auto" | "device" | "loopback";
	group?: string;
	defaultGroup?: boolean;
	noTerminal?: boolean;
	noFiles?: boolean;
	allowFileWrite?: boolean;
	allowProjectConfig?: boolean;
	workspaceRoots?: string[];
	safeDirs?: string[];
}

export class IpcError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

function onlyKeys(v: Record<string, unknown>, keys: string[]): void {
	for (const k of Object.keys(v)) if (!keys.includes(k)) throw new IpcError(`unknown field ${k}`);
}
function str(v: unknown, what: string, max = 2000): string {
	if (typeof v !== "string" || v.length > max || v.includes("\0"))
		throw new IpcError(`bad ${what}`);
	return v;
}
function bool(v: unknown, what: string): boolean {
	if (typeof v !== "boolean") throw new IpcError(`bad ${what}`);
	return v;
}
function oneOf<T extends string>(v: unknown, set: readonly T[], what: string): T {
	if (typeof v !== "string" || !(set as readonly string[]).includes(v))
		throw new IpcError(`bad ${what}`);
	return v as T;
}
/** A value that galopin gets as a flag argument: never starts with a dash, no control characters. */
function arg(v: unknown, what: string, max = 500): string {
	const s = str(v, what, max);
	// eslint-disable-next-line no-control-regex
	if (s.startsWith("-") || /[\u0000-\u001f]/.test(s) || s.length === 0)
		throw new IpcError(`bad ${what}`);
	return s;
}
function pathList(v: unknown, what: string): string[] {
	if (!Array.isArray(v) || v.length > 20) throw new IpcError(`bad ${what}`);
	return v.map((p) => {
		const s = arg(p, what, 1000);
		if (!s.startsWith("/") && !/^~\//.test(s))
			throw new IpcError(`${what} must be an absolute path`);
		return s;
	});
}

export function validate<C extends Channel>(channel: C, raw: unknown): Calls[C] {
	const none = (): Calls[C] => {
		if (raw !== undefined && raw !== null) throw new IpcError("no argument expected");
		return undefined as Calls[C];
	};
	const obj = (keys: string[]): Record<string, unknown> => {
		if (!isObj(raw)) throw new IpcError("an object is expected");
		onlyKeys(raw, keys);
		return raw;
	};
	const out = (v: unknown) => v as Calls[C];
	switch (channel) {
		case "server:get":
		case "galopin:status":
		case "galopin:start":
		case "galopin:stop":
		case "galopin:browser-setup":
		case "galopin:edit-connectors":
		case "galopin:logs":
		case "app:open-cerea":
		case "app:state":
			return none();
		case "server:probe":
		case "server:set": {
			const o = obj(["address"]);
			return out({ address: str(o.address, "address", 300) });
		}
		case "server:switch": {
			const o = obj(["address", "confirm"]);
			if (o.confirm !== true) throw new IpcError("switching a server needs confirmation");
			return out({ address: str(o.address, "address", 300), confirm: true });
		}
		case "galopin:launch": {
			const o = obj(["tool", "dir"]);
			return out({
				tool: oneOf(o.tool, TOOLS, "tool"),
				...(o.dir === undefined ? {} : { dir: pathList([o.dir], "dir")[0] }),
			});
		}
		case "galopin:setup": {
			const o = obj(["tool", "remove", "makeDefault"]);
			return out({
				tool: oneOf(o.tool, TOOLS, "tool"),
				remove: bool(o.remove, "remove"),
				makeDefault: bool(o.makeDefault, "makeDefault"),
			});
		}
		case "galopin:upgrade": {
			const o = obj(["show"]);
			return out({ show: bool(o.show, "show") });
		}
		case "galopin:service": {
			const o = obj(["action"]);
			return out({
				action: oneOf(o.action, ["install", "uninstall", "status"] as const, "action"),
			});
		}
		case "galopin:pair": {
			const o = obj([
				"agent",
				"engine",
				"flow",
				"group",
				"defaultGroup",
				"noTerminal",
				"noFiles",
				"allowFileWrite",
				"allowProjectConfig",
				"workspaceRoots",
				"safeDirs",
			]);
			const p: PairOptions = { agent: bool(o.agent, "agent") };
			if (o.engine !== undefined) p.engine = oneOf(o.engine, ENGINES, "engine");
			if (o.flow !== undefined)
				p.flow = oneOf(o.flow, ["auto", "device", "loopback"] as const, "flow");
			if (o.group !== undefined) p.group = arg(o.group, "group", 200);
			for (const k of [
				"defaultGroup",
				"noTerminal",
				"noFiles",
				"allowFileWrite",
				"allowProjectConfig",
			] as const) {
				if (o[k] !== undefined) p[k] = bool(o[k], k);
			}
			if (o.workspaceRoots !== undefined)
				p.workspaceRoots = pathList(o.workspaceRoots, "workspaceRoots");
			if (o.safeDirs !== undefined) p.safeDirs = pathList(o.safeDirs, "safeDirs");
			if (!p.agent) {
				// Connectors-only computers take none of the agent options.
				for (const k of Object.keys(p))
					if (k !== "agent" && k !== "flow")
						throw new IpcError(`${k} needs a coding-agent computer`);
			}
			return out(p);
		}
		case "browser:layout": {
			const o = obj(["x", "y", "width", "height", "visible", "sideWidth"]);
			const n = (v: unknown, w: string) => {
				if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 20000)
					throw new IpcError(`bad ${w}`);
				return Math.round(v);
			};
			return out({
				x: n(o.x, "x"),
				y: n(o.y, "y"),
				width: n(o.width, "width"),
				height: n(o.height, "height"),
				visible: bool(o.visible, "visible"),
				sideWidth: n(o.sideWidth, "sideWidth"),
			});
		}
		case "browser:open": {
			const o = obj(["url"]);
			return out({ url: str(o.url, "url", 2000) });
		}
		case "browser:tab": {
			const o = obj(["action", "id"]);
			return out({
				action: oneOf(o.action, ["activate", "close"] as const, "action"),
				id: str(o.id, "id", 64),
			});
		}
		case "browser:nav": {
			const o = obj(["action"]);
			return out({ action: oneOf(o.action, ["back", "forward", "reload"] as const, "action") });
		}
		case "browser:control": {
			const o = obj(["mode"]);
			return out({ mode: oneOf(o.mode, ["agent", "user"] as const, "mode") });
		}
		default:
			throw new IpcError("unknown channel");
	}
}

export const CHANNELS: Channel[] = [
	"server:probe",
	"server:set",
	"server:switch",
	"server:get",
	"galopin:status",
	"galopin:pair",
	"galopin:start",
	"galopin:stop",
	"galopin:launch",
	"galopin:setup",
	"galopin:upgrade",
	"galopin:service",
	"galopin:browser-setup",
	"galopin:edit-connectors",
	"galopin:logs",
	"browser:layout",
	"browser:open",
	"browser:tab",
	"browser:nav",
	"browser:control",
	"app:open-cerea",
	"app:state",
];

/** Events main pushes to the renderer. */
export const EVENTS = ["state", "output", "agent-active"] as const;
export type EventName = (typeof EVENTS)[number];

export interface BrowserState {
	tabs: { id: string; title: string; url: string; active: boolean }[];
	mode: "agent" | "user";
	/** The runtime sent a command in the last few seconds. */
	agentBusy: boolean;
	connected: boolean;
}
export interface ServerInfo {
	/** The identity provider's origin, from the server's own sign-in settings: the one other origin the window may reach. */
	idp: string;
	origin: string;
	address: string;
	name: string;
	icon?: string;
}
export interface AppState {
	server: ServerInfo | null;
	galopin: { available: boolean; paired: boolean; pairedAddress: string; running: boolean };
	browser: BrowserState;
	platform: string;
}
