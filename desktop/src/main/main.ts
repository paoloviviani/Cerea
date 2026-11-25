import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	Menu,
	protocol,
	powerMonitor,
	net,
	session,
	shell,
	WebContentsView,
	type IpcMainInvokeEvent,
	type WebContents,
} from "electron";
import { BridgeRouter, CdpBridge } from "./cdpBridge.ts";
import { startBridgeServer, type BridgeServer } from "./bridgeServer.ts";
import { BrowserPanel } from "./browserPanel.ts";
import { Control } from "./control.ts";
import { ensureNode } from "./nodeRuntime.ts";
import { linuxLogin, linuxLoginEnabled } from "./login.ts";
import { findGalopin, Galopin } from "./galopin.ts";
import {
	enrollArgs,
	launchArgs,
	serviceArgs,
	setupArgs,
	upgradeArgs,
	withCreds,
} from "./galopinArgs.ts";
import { guardCerea, mayOpenExternally, UI_CSP, type GuardState } from "./navGuard.ts";
import { resolveUiFile, UI_ORIGIN } from "./uiProtocol.ts";
import { cappedFetch, iconFetcher } from "./probeFetch.ts";
import {
	activeProfile,
	addProfile,
	ceraePartition,
	panelPartition,
	profileGalopinDir,
	removeProfile,
	renameProfile,
	saveStore,
	switchTo,
	loadStore,
	type Profile,
	type Store,
} from "./profiles.ts";
import { discoverServer, ServerError } from "./server.ts";
import {
	CHANNELS,
	IpcError,
	validate,
	type AppState,
	type Calls,
	type Channel,
} from "../shared/ipc.ts";

const HEADER = 40;
// Test hooks exist only in an unpackaged run: a packaged app ignores these variables.
const TEST = !app.isPackaged && process.env.CEREA_DESKTOP_TEST === "1";

// The app's own settings, and nothing else, live in userData; a test points it elsewhere.
if (process.env.CEREA_DESKTOP_USER_DATA)
	app.setPath("userData", process.env.CEREA_DESKTOP_USER_DATA);

let win: BrowserWindow | undefined;
let ceraeView: WebContentsView | undefined;
let panel: BrowserPanel | undefined;
let galopin: Galopin;
let bridgeServer: BridgeServer | undefined;
let store: Store = { active: null, profiles: [] };
const router = new BridgeRouter();
let nodeBinDir: string | undefined;
const guard: GuardState = { origin: "" };
const control = new Control();
let bridgeConnected = false;
let sideWidth = 0;
let log: string[] = [];

const uiDir = () => join(__dirname, "..", "renderer");

function push(event: string, data: unknown): void {
	if (win && !win.isDestroyed()) win.webContents.send(`ev:${event}`, data);
}
function line(l: string): void {
	log = [...log.slice(-499), l];
	push("output", l);
}

function appState(): AppState {
	return {
		server: cur()?.server ?? null,
		profiles: store.profiles.map((p) => ({
			id: p.id,
			name: p.name,
			address: p.server.address,
			...(p.server.icon ? { icon: p.server.icon } : {}),
			active: p.id === store.active,
		})),
		galopin: {
			available: galopin.available,
			paired: galopin.paired(),
			pairedAddress: galopin.pairedAddress(),
			running: galopin.running,
		},
		browser: panel
			? panel.state()
			: { tabs: [], mode: control.mode, agentBusy: false, connected: false },
		platform: process.platform,
		startAtLogin: loginEnabled(),
		version: app.getVersion(),
		packaged: app.isPackaged,
	};
}
function loginEnabled(): boolean {
	return process.platform === "darwin"
		? app.getLoginItemSettings().openAtLogin
		: linuxLoginEnabled();
}
function setLogin(enabled: boolean): void {
	if (process.platform === "darwin") app.setLoginItemSettings({ openAtLogin: enabled });
	else linuxLogin(enabled, { execPath: process.execPath });
}
const pushState = () => push("state", appState());

// ---- the Cerea window -----------------------------------------------------------------------

function placeCerea(): void {
	if (!win || !ceraeView) return;
	const b = win.getContentBounds();
	const show = !!cur() && sideWidth < b.width;
	ceraeView.setVisible(show);
	if (show)
		ceraeView.setBounds({ x: 0, y: HEADER, width: b.width - sideWidth, height: b.height - HEADER });
}

function makeCereaView(profile: Profile): WebContentsView {
	const view = new WebContentsView({
		// The deployment's own page: no preload, no Node, sandboxed, its own storage.
		webPreferences: {
			partition: ceraePartition(profile.id),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webSecurity: true,
			backgroundThrottling: true,
			devTools: !app.isPackaged,
		},
	});
	const wc = view.webContents;
	const apply = (r: ReturnType<typeof guardCerea>) => {
		if (r.excursion !== undefined) guard.excursion = r.excursion ?? undefined;
	};
	wc.on("will-navigate", (e, url) => {
		const r = guardCerea(guard, "navigate", url, wc.getURL());
		apply(r);
		if (r.decision !== "allow") {
			e.preventDefault();
			if (r.decision === "external" && mayOpenExternally(url)) void shell.openExternal(url);
		}
	});
	wc.on("will-redirect", (e, url) => {
		const r = guardCerea(guard, "redirect", url, wc.getURL());
		apply(r);
		if (r.decision !== "allow") {
			e.preventDefault();
			if (r.decision === "external" && mayOpenExternally(url)) void shell.openExternal(url);
		}
	});
	wc.setWindowOpenHandler(({ url }) => {
		const r = guardCerea(guard, "window-open", url, wc.getURL());
		if (r.decision === "allow") void wc.loadURL(url);
		else if (r.decision === "external" && mayOpenExternally(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	const ses = session.fromPartition(ceraePartition(profile.id));
	// What Cerea may ask the OS for: the clipboard (copy buttons) and notifications.
	// Only the chosen server itself (not the identity provider, not a frame of another origin) is asked.
	const granted = (perm: string, origin: string | undefined) =>
		["clipboard-sanitized-write", "notifications"].includes(perm) &&
		!!origin &&
		origin === guard.origin;
	ses.setPermissionRequestHandler((_wc, perm, cb, details) => {
		let o: string | undefined;
		try {
			o = new URL(details.requestingUrl).origin;
		} catch {
			o = undefined;
		}
		cb(granted(perm, o));
	});
	ses.setPermissionCheckHandler((_wc, perm, requestingOrigin) => granted(perm, requestingOrigin));
	return view;
}

const cur = (): Profile | undefined => activeProfile(store);

/**
 * Shows the active profile: a new Cerea view on that profile's own session (the old one is
 * closed), the guard for its origin and identity provider, a new browser panel on its own
 * session behind the bridge, and its galopin. With no profile, nothing of Cerea is loaded.
 */
function loadActive(): void {
	const p = cur();
	if (ceraeView && win) {
		try {
			win.contentView.removeChildView(ceraeView);
			ceraeView.webContents.close();
		} catch {
			// the window is closing
		}
		ceraeView = undefined;
	}
	guard.origin = p?.server.origin ?? "";
	guard.idp = p?.server.idp;
	guard.excursion = undefined;
	control.set("agent");
	if (win && p) {
		ceraeView = makeCereaView(p);
		// Under the browser panel's views: they are added after, so they stay on top.
		win.contentView.addChildView(ceraeView, 0);
		void ceraeView.webContents.loadURL(p.server.address + "/").catch(() => {});
		panel = new BrowserPanel(
			win,
			control,
			(st) => push("state", { ...appState(), browser: st }),
			() => bridgeConnected,
			panelPartition(p.id)
		);
		panel.setLayout(lastRect);
		router.set(new CdpBridge(panel, control, (m) => line(`[bridge] ${m}`)));
		galopin = makeGalopin(p);
	} else {
		panel = undefined;
		router.set(undefined);
		galopin = makeGalopin(undefined);
	}
	win?.setTitle(p ? `Cerea \u2014 ${p.name}` : "Cerea");
	setMenu();
	placeCerea();
	pushState();
}

let lastRect = { x: 0, y: 0, width: 0, height: 0, visible: false };

/** A galopin for a profile: the first uses galopin's default directory, the others their own (`--creds`). */
function makeGalopin(p: Profile | undefined): Galopin {
	const dir = p ? profileGalopinDir(app.getPath("userData"), p) : undefined;
	if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const g = new Galopin(
		findGalopin({
			resources: process.resourcesPath,
			devRoot: join(__dirname, "..", ".."),
			packaged: app.isPackaged,
		}),
		line,
		process.env,
		pushState,
		dir ? join(dir, "credentials.json") : undefined
	);
	if (nodeBinDir) g.useNode(nodeBinDir);
	return g;
}

// ---- IPC ------------------------------------------------------------------------------------

function fromUi(e: IpcMainInvokeEvent): boolean {
	return (
		!!win &&
		e.sender === win.webContents &&
		e.senderFrame === win.webContents.mainFrame &&
		(e.senderFrame?.url ?? "").startsWith(`${UI_ORIGIN}/`)
	);
}

type Handler<C extends Channel> = (arg: Calls[C]) => Promise<unknown> | unknown;

async function confirm(message: string, detail: string, button: string): Promise<boolean> {
	if (TEST) return process.env.CEREA_DESKTOP_TEST_CONFIRM === "1";
	const r = await dialog.showMessageBox(win!, {
		type: "question",
		message,
		detail,
		buttons: [button, "Cancel"],
		defaultId: 1,
		cancelId: 1,
	});
	return r.response === 0;
}

const netFetch = (
	url: string,
	init: { signal: AbortSignal; redirect: "manual"; credentials: "omit" }
) => net.fetch(url, init);
const fetchForProbe = cappedFetch(netFetch);
const probe = (address: string) => discoverServer(address, fetchForProbe, iconFetcher(netFetch));

const handlers: { [C in Channel]: Handler<C> } = {
	"server:get": () => cur()?.server ?? null,
	"server:probe": async ({ address }) => probe(address),
	"profile:add": async ({ address, name }) => {
		const server = await probe(address);
		const { store: next, profile } = addProfile(store, server, name);
		const first = store.profiles.length === 0;
		store = next;
		saveStore(app.getPath("userData"), store);
		if (first) loadActive();
		else await switchProfile(profile.id);
		setMenu();
		pushState();
		return profile.id;
	},
	"profile:switch": async ({ id }) => {
		await switchProfile(id);
		return id;
	},
	"profile:rename": ({ id, name }) => {
		store = renameProfile(store, id, name);
		saveStore(app.getPath("userData"), store);
		win?.setTitle(cur() ? `Cerea \u2014 ${cur()!.name}` : "Cerea");
		setMenu();
		pushState();
	},
	"profile:remove": async ({ id }) => removeProfileFlow(id),
	"galopin:status": async () => (await galopin.exec(["status"])).output,
	"galopin:pair": async (o) => {
		const p = cur();
		if (!p) throw new IpcError("Choose a server first.");
		const r = await galopin.exec(enrollArgs(p.server.address, o));
		if (r.code === 0) galopin.start();
		pushState();
		return r.code === 0 ? "Paired." : `Pairing failed (exit ${r.code}).`;
	},
	"galopin:start": () => {
		galopin.start();
		setTimeout(pushState, 500);
	},
	"galopin:stop": async () => {
		await galopin.stop();
		pushState();
	},
	"galopin:launch": async ({ tool, dir }) => {
		let cwd = dir;
		if (!cwd) {
			const r = await dialog.showOpenDialog(win!, {
				properties: ["openDirectory"],
				defaultPath: homedir(),
			});
			if (r.canceled || !r.filePaths[0]) return "Cancelled.";
			cwd = r.filePaths[0];
		}
		return galopin.launchInTerminal(withCreds(launchArgs(tool), galopin.credsPath), cwd).message;
	},
	"galopin:setup": async ({ tool, remove, makeDefault }) => {
		if (
			remove &&
			!(await confirm(
				`Remove ${tool}-galopin?`,
				"Deletes the command and shim galopin made for this tool.",
				"Remove"
			))
		)
			return "Cancelled.";
		if (
			makeDefault &&
			!(await confirm(
				`Make ${tool} go through galopin?`,
				"Adds a shim directory you put first on PATH; no shell file is edited.",
				"Set up"
			))
		)
			return "Cancelled.";
		return (await galopin.exec(setupArgs(tool, remove, makeDefault))).output;
	},
	"galopin:upgrade": async ({ show }) => {
		if (
			!show &&
			!(await confirm(
				"Upgrade galopin?",
				"Runs galopin upgrade: it stops galopin, installs the version your Cerea serves and restarts it. Enrollment is kept.",
				"Upgrade"
			))
		)
			return "Cancelled.";
		return (await galopin.exec(upgradeArgs(show))).output;
	},
	"galopin:service": async ({ action }) => {
		if (
			action === "install" &&
			!(await confirm(
				"Keep galopin running in the background?",
				"Installs a service that starts galopin when you log in. The app's own galopin is stopped first so only one runs.",
				"Install service"
			))
		)
			return "Cancelled.";
		if (
			action === "uninstall" &&
			!(await confirm(
				"Remove the galopin service?",
				"galopin then only runs while this app is open.",
				"Remove service"
			))
		)
			return "Cancelled.";
		if (action === "install") await galopin.stop();
		const r = await galopin.exec(serviceArgs(action));
		if (action === "uninstall" && r.code === 0 && galopin.paired()) galopin.start();
		pushState();
		return r.output;
	},
	"galopin:browser-setup": async () => {
		if (!bridgeServer) throw new IpcError("The browser panel is not ready.");
		// The Node the app ships, unless this is a development run: then the one on PATH.
		const node = ensureNode({
			resources: process.resourcesPath,
			userData: app.getPath("userData"),
		});
		if (node) {
			nodeBinDir = node.binDir;
			galopin.useNode(node.binDir);
			line(`Using the app's own Node ${node.version}.`);
		}
		const a = await galopin.exec(["browser", "setup", "--connect-file", bridgeServer.endpointFile]);
		if (a.code !== 0) return a.output;
		return (await galopin.exec(["browser", "enable"])).output;
	},
	"galopin:edit-connectors": async () => {
		const file = join(galopin.configDir(), "mcp.json");
		if (!existsSync(file)) {
			mkdirSync(galopin.configDir(), { recursive: true, mode: 0o700 });
			writeFileSync(file, '{"mcpServers": {}}\n', { mode: 0o600 });
		}
		const err = await shell.openPath(file);
		return err || "Opened. Saved changes are picked up automatically.";
	},
	"galopin:logs": () => log.join("\n"),
	"browser:layout": ({ sideWidth: w, ...rect }) => {
		sideWidth = w;
		lastRect = rect;
		placeCerea();
		panel?.setLayout(rect);
	},
	"browser:open": ({ url }) => panel?.openForUser(url),
	"browser:tab": ({ action, id }) =>
		action === "activate" ? panel?.activate(id) : panel?.close(id),
	"browser:nav": ({ action }) => panel?.navigate(action),
	"browser:control": ({ mode }) => control.set(mode),
	"app:state": () => appState(),
	"app:login": ({ enabled }) => {
		setLogin(enabled);
		pushState();
		return enabled;
	},
	"app:open-cerea": () => {
		const a = cur()?.server.address;
		if (a && mayOpenExternally(a)) void shell.openExternal(a);
	},
};

function registerIpc(): void {
	for (const channel of CHANNELS) {
		ipcMain.handle(channel, async (e, raw: unknown) => {
			if (!fromUi(e)) throw new IpcError("not allowed");
			try {
				const arg = validate(channel, raw);
				return await (handlers[channel] as Handler<Channel>)(arg as never);
			} catch (err) {
				// Only the message crosses: a plain string, never a stack or an object of ours.
				throw new Error(err instanceof Error ? err.message : String(err));
			}
		});
	}
}

/** A menu for copy and paste and window keys; no View menu, so no DevTools in a packaged app. */
function setMenu(): void {
	const profiles: Electron.MenuItemConstructorOptions = {
		label: "Profiles",
		submenu: store.profiles.map((p, i) => ({
			label: p.name,
			type: "radio" as const,
			checked: p.id === store.active,
			accelerator: i < 9 ? `CmdOrCtrl+Shift+${i + 1}` : undefined,
			click: () => void switchProfile(p.id).catch((e) => line(`Switch failed: ${String(e)}`)),
		})),
	};
	const template: Electron.MenuItemConstructorOptions[] = [
		...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
		{ role: "editMenu" },
		...(store.profiles.length > 1 ? [profiles] : []),
		{ role: "windowMenu" },
		...(app.isPackaged ? [] : [{ role: "viewMenu" as const }]),
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- profiles -------------------------------------------------------------------------------

/**
 * Makes another profile the active one: its galopin runs and the old one does not (the old one is
 * gone before anything of the new starts), the runtime is cut off from the old panel, and the
 * Cerea view and panel are the new profile's own, on their own sessions. An installed galopin
 * service follows the active profile, after a confirmation.
 */
async function switchProfile(id: string): Promise<void> {
	const target = store.profiles.find((p) => p.id === id);
	if (!target || store.active === id) return;
	const service = galopin.serviceInstalled();
	if (
		service &&
		!(await confirm(
			`Switch to ${target.name}?`,
			`The galopin service follows the active profile. It is installed again for ${target.name}, or removed if this computer is not paired with that server yet.`,
			"Switch"
		))
	) {
		return;
	}
	store = await switchTo(store, id, {
		stopGalopin: () => galopin.stop(),
		detachRuntime: () => {
			router.set(undefined);
			control.set("agent");
		},
		closePanel: () => {
			panel?.dispose();
			panel = undefined;
		},
		loadProfile: (p) => {
			store = { ...store, active: p.id };
			loadActive();
		},
		save: (st) => saveStore(app.getPath("userData"), st),
		startGalopin: async () => {
			if (service) {
				await galopin.exec(serviceArgs(galopin.paired() ? "install" : "uninstall"));
			} else if (galopin.paired() && !TEST) galopin.start();
		},
	});
	pushState();
}

/** Removes a profile after a confirmation: its sessions and its pairing on this computer go; the server is not told. */
async function removeProfileFlow(id: string): Promise<boolean> {
	const p = store.profiles.find((x) => x.id === id);
	if (!p) throw new IpcError("No such profile.");
	const ok = await confirm(
		`Remove ${p.name}?`,
		`Its sign-in here, its browser panel's logins and this computer's pairing with it are deleted from this computer. The server is not told: this computer's sign-in there stays valid until you remove the computer from that server's Agents panel.`,
		"Remove"
	);
	if (!ok) return false;
	if (store.active === id) {
		const other = store.profiles.find((x) => x.id !== id);
		if (other) await switchProfile(other.id);
		else {
			await galopin.stop();
			if (galopin.serviceInstalled()) await galopin.exec(serviceArgs("uninstall"));
		}
		if (store.active === id && other) return false; // the switch was declined: nothing removed
	}
	// A galopin of that profile (never the running one) to set its pairing aside.
	const dir = profileGalopinDir(app.getPath("userData"), p);
	if (dir) rmSync(join(dir, ".."), { recursive: true, force: true });
	else makeGalopin(p).unpairLocal();
	await session.fromPartition(ceraePartition(p.id)).clearStorageData();
	await session.fromPartition(panelPartition(p.id)).clearStorageData();
	store = removeProfile(store, id);
	saveStore(app.getPath("userData"), store);
	if (!store.active) loadActive();
	setMenu();
	pushState();
	return true;
}

// ---- energy -----------------------------------------------------------------------------------

/**
 * Work follows the machine's state. Asleep or locked: the browser panel's pages are frozen at
 * once. On battery, or when macOS reports serious or critical thermal pressure: they are frozen
 * after seconds instead of half a minute. Nothing here polls: these are OS events.
 */
function watchPower(): void {
	const low = () => {
		const thermal = (
			powerMonitor as unknown as { getCurrentThermalState?: () => string }
		).getCurrentThermalState?.();
		return powerMonitor.isOnBatteryPower() || thermal === "serious" || thermal === "critical";
	};
	const update = (now = false) => {
		if (!panel) return;
		panel.lowPower = low();
		panel.scheduleIdle(now);
	};
	update();
	powerMonitor.on("on-battery", () => update());
	powerMonitor.on("on-ac", () => update());
	powerMonitor.on("thermal-state-change", () => update());
	powerMonitor.on("suspend", () => {
		if (panel) panel.lowPower = true;
		update(true);
	});
	powerMonitor.on("lock-screen", () => {
		if (panel) panel.lowPower = true;
		update(true);
	});
	powerMonitor.on("resume", () => update());
	powerMonitor.on("unlock-screen", () => update());
}

/** Test-only: a line on stdin asks for CPU numbers or hides the window (see scripts/smoke.mjs). */
function testHooks(): void {
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		for (const cmd of chunk
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)) {
			if (cmd === "metrics") {
				const cpu = app
					.getAppMetrics()
					.map((m) => ({ type: m.type, pid: m.pid, cpu: m.cpu.cumulativeCPUUsage ?? 0 }));
				process.stdout.write(`METRICS ${JSON.stringify({ at: Date.now(), cpu })}\n`);
			} else if (cmd === "hide") win?.hide();
			else if (cmd === "show") win?.show();
			else if (cmd === "state") process.stdout.write(`STATE ${JSON.stringify(appState())}\n`);
			else if (cmd === "targetids") {
				// The real DevTools target ids of the local UI and the Cerea view, for the smoke test to aim at.
				void (async () => {
					const dbg = win!.webContents.debugger;
					const had = dbg.isAttached();
					if (!had) dbg.attach("1.3");
					try {
						const t = (await dbg.sendCommand("Target.getTargets")) as {
							targetInfos: { targetId: string; url: string; type: string }[];
						};
						process.stdout.write(
							`TARGETIDS ${JSON.stringify(t.targetInfos.filter((x) => x.type === "page").map((x) => ({ id: x.targetId, url: x.url })))}\n`
						);
					} finally {
						if (!had) dbg.detach();
					}
				})();
			} else if (cmd.startsWith("addprofile ")) {
				void Promise.resolve(handlers["profile:add"]({ address: cmd.slice(11) })).then(
					() => process.stdout.write(`PROFILES ${JSON.stringify(appState().profiles)}\n`),
					(e) => process.stdout.write(`PROFILES ${JSON.stringify({ error: String(e) })}\n`)
				);
			} else if (cmd.startsWith("switchprofile ")) {
				const target = store.profiles[Number(cmd.slice(14))];
				void Promise.resolve(target && handlers["profile:switch"]({ id: target.id })).then(() =>
					process.stdout.write(`PROFILES ${JSON.stringify(appState().profiles)}\n`)
				);
			} else if (cmd.startsWith("cookie ")) {
				// Sets a cookie in the ACTIVE profile's Cerea session and its panel session, then lists
				// the cookie names of every profile's two sessions, to show nothing crosses.
				const name = cmd.slice(7);
				void (async () => {
					const p = cur()!;
					if (name !== "-") {
						await session
							.fromPartition(ceraePartition(p.id))
							.cookies.set({ url: p.server.origin + "/", name, value: "1" });
						await session
							.fromPartition(panelPartition(p.id))
							.cookies.set({ url: p.server.origin + "/", name: name + "-panel", value: "1" });
					}
					const out = [];
					for (const q of store.profiles) {
						const c = (await session.fromPartition(ceraePartition(q.id)).cookies.get({})).map(
							(x) => x.name
						);
						const d = (await session.fromPartition(panelPartition(q.id)).cookies.get({})).map(
							(x) => x.name
						);
						out.push({ cerea: c, panel: d });
					}
					process.stdout.write(`COOKIES ${JSON.stringify(out)}\n`);
				})();
			} else if (cmd.startsWith("usernav ")) panel?.openForUser(cmd.slice(8));
			else if (cmd.startsWith("control ")) control.set(cmd.endsWith("user") ? "user" : "agent");
			else if (cmd === "tabs")
				process.stdout.write(`TABS ${JSON.stringify(panel?.state().tabs ?? [])}\n`);
			else if (cmd === "cerea") {
				const wc = ceraeView?.webContents;
				process.stdout.write(
					`CEREA ${JSON.stringify({ url: wc?.getURL(), title: wc?.getTitle(), visible: ceraeView?.getVisible?.() })}\n`
				);
			} else if (cmd === "ui") {
				void win?.webContents
					.executeJavaScript(
						`JSON.stringify({title: document.title, bridge: typeof window.cerea?.call, setupHidden: document.getElementById('setup').hidden, panes: [...document.querySelectorAll('section')].filter(s=>!s.hidden).map(s=>s.id)})`
					)
					.then((r: string) => process.stdout.write(`UI ${r}\n`));
			} else if (cmd === "galopin") {
				void Promise.resolve(handlers["galopin:status"](undefined)).then((o: unknown) =>
					process.stdout.write(
						`GALOPIN ${JSON.stringify({ available: galopin.available, output: o })}\n`
					)
				);
			}
		}
	});
}

// ---- start up -------------------------------------------------------------------------------

function lockDownWebContents(): void {
	app.on("web-contents-created", (_e, wc: WebContents) => {
		// Nothing may attach a <webview>, and every web contents asks the guards above before it navigates.
		wc.on("will-attach-webview", (ev) => ev.preventDefault());
	});
}

async function createWindow(): Promise<void> {
	win = new BrowserWindow({
		width: 1360,
		height: 860,
		minWidth: 900,
		minHeight: 560,
		show: !TEST || process.env.CEREA_DESKTOP_SHOW === "1",
		title: "Cerea",
		webPreferences: {
			preload: join(__dirname, "..", "preload", "ui.js"),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webSecurity: true,
			backgroundThrottling: true,
			devTools: !app.isPackaged,
		},
	});
	// The UI's policy is a <meta> tag and a header of its own protocol; navigating away is refused.
	win.webContents.on("will-navigate", (e) => e.preventDefault());
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

	win.on("resize", placeCerea);

	try {
		bridgeServer = await startBridgeServer(router, {
			runDir: join(app.getPath("userData"), "run"),
			uid: process.getuid?.() ?? 0,
			control,
		});
	} catch (err) {
		// A bridge that cannot start switches the browser panel off, not the app.
		bridgeServer = undefined;
		line(`The browser panel is off: ${err instanceof Error ? err.message : String(err)}`);
	}
	control.onChange(pushState);
	await win.loadURL(`${UI_ORIGIN}/index.html`);
	loadActive();
}

protocol.registerSchemesAsPrivileged([
	{ scheme: "app", privileges: { standard: true, secure: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();
else {
	app.on("second-instance", () => {
		if (win) {
			if (win.isMinimized()) win.restore();
			win.focus();
		}
	});
	app.whenReady().then(async () => {
		lockDownWebContents();
		protocol.handle("app", (req) => {
			const f = resolveUiFile(uiDir(), req.url);
			if (!f) return new Response("not found", { status: 404 });
			return new Response(readFileSync(f.path), {
				headers: { "content-type": f.type, "content-security-policy": UI_CSP },
			});
		});
		// Nothing outside the two named partitions asks the OS for anything.
		session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
		session.defaultSession.setPermissionCheckHandler(() => false);
		setMenu();
		store = loadStore(app.getPath("userData"));
		galopin = makeGalopin(cur());
		registerIpc();
		await createWindow();
		// A paired computer keeps galopin going while the app is open (the Mac connector app's job).
		if (galopin.paired() && !TEST) galopin.start();
		watchPower();
		// No timer refreshes the screen: state is pushed when something changes, and again when the
		// window is looked at (focus), so a galopin started elsewhere shows up when it matters.
		win?.on("focus", pushState);
		if (TEST) testHooks();
		if (TEST) process.stdout.write(`CEREA_DESKTOP_READY ${bridgeServer?.endpointFile}\n`);
	});
	app.on("window-all-closed", () => app.quit());
	let quitting = false;
	app.on("before-quit", (e) => {
		if (quitting) return;
		// Let go of the socket and the child before the process ends, not after.
		e.preventDefault();
		quitting = true;
		void Promise.allSettled([galopin?.stop(), bridgeServer?.close()]).finally(() => app.quit());
	});
}
