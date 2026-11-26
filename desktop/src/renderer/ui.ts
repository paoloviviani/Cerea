import { dedupeLog } from "../shared/dedupe.ts";
import type { AppState, Calls, GalopinInfo, ServerInfo } from "../shared/ipc.ts";

declare global {
	interface Window {
		cerea: {
			call(channel: string, arg?: unknown): Promise<unknown>;
			on(event: string, cb: (data: unknown) => void): () => void;
		};
	}
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const call = <C extends keyof Calls>(c: C, arg?: Calls[C]) => window.cerea.call(c, arg);
const msg = (e: unknown) =>
	e instanceof Error
		? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")
		: String(e);

let state: AppState | undefined;
let candidate: ServerInfo | undefined;
let switchCandidate: ServerInfo | undefined;

function show(el: HTMLElement, on: boolean) {
	el.hidden = !on;
}

let logProfile = "";
function render() {
	if (!state) return;
	const s = state;
	// Each profile has its own log: another profile's lines are not shown or read for its sign-in.
	const activeId = s.profiles.find((p) => p.active)?.id ?? "";
	if (activeId !== logProfile) {
		logProfile = activeId;
		void call("galopin:logs").then((t) => {
			logLines = String(t).split("\n").filter(Boolean);
			if (logShown) renderLog();
		});
	}
	const first = !s.server;
	const open = !first && s.panel.open;
	const pane = s.panel.pane;
	show($("setup"), first);
	show($("side"), open);
	document.documentElement.style.setProperty("--side-w", `${s.panel.width}px`);
	for (const b of document.querySelectorAll<HTMLButtonElement>("#bar [data-pane]")) {
		b.hidden = first;
		b.setAttribute("aria-pressed", String(open && b.dataset.pane === pane));
	}
	const working = !first && s.panel.working;
	$("tab-browser").classList.toggle("working", working);
	$("tab-browser-label").textContent = working ? "Browser working\u2026" : "Browser";
	$("open-cerea").hidden = first;
	$("server-name").textContent = s.server?.name ?? "Cerea";
	const logo = $<HTMLImageElement>("logo");
	logo.hidden = !s.server?.icon;
	if (s.server?.icon) logo.src = s.server.icon;
	for (const p of ["browser", "galopin", "server"] as const)
		show($(`pane-${p}`), open && pane === p);

	// galopin: the card is drawn from `galopin:info`, fetched when this tab is showing
	if (open && pane === "galopin") scheduleInfo();
	$<HTMLInputElement>("s-login").checked = s.startAtLogin;
	$("s-about").textContent =
		`Cerea desktop ${s.version}${s.packaged ? "" : " (development build)"}. ${
			s.platform === "darwin"
				? "This Mac build is not signed or notarised by Apple, so macOS asks you to confirm the first time you open it, and the app does not update itself: download a new version to update."
				: "The app does not update itself yet: install a new version to update."
		}`;
	renderProfiles(s);

	// browser
	const b = s.browser;
	const tabs = $("tabs");
	tabs.replaceChildren(
		...b.tabs.map((t) => {
			const el = document.createElement("button");
			el.textContent = t.title || t.url || "New tab";
			el.title = t.url;
			el.setAttribute("aria-pressed", String(t.active));
			el.onclick = () => void call("browser:tab", { action: "activate", id: t.id });
			el.oncontextmenu = (ev) => {
				ev.preventDefault();
				void call("browser:tab", { action: "close", id: t.id });
			};
			return el;
		})
	);
	const text = $("control-text");
	const btn = $<HTMLButtonElement>("control-button");
	if (b.mode === "user") {
		text.textContent = "You are driving. Cerea waits.";
		btn.textContent = "Hand back to Cerea";
	} else if (b.agentBusy) {
		text.textContent = "Cerea is browsing. Watch, or take over.";
		btn.textContent = "Take over";
	} else {
		text.textContent = b.connected
			? "Cerea can use this browser."
			: "Cerea can use this browser when a task needs it.";
		btn.textContent = "Take over";
	}
	btn.onclick = () => void call("browser:control", { mode: b.mode === "user" ? "agent" : "user" });
	reportLayout();
}

function renderProfiles(s: AppState) {
	const sel = $<HTMLSelectElement>("profile-select");
	sel.hidden = s.profiles.length === 0;
	sel.replaceChildren(
		...s.profiles.map((p) => {
			const o = document.createElement("option");
			o.value = p.id;
			o.textContent = p.name;
			o.selected = p.active;
			return o;
		}),
		Object.assign(document.createElement("option"), {
			value: "__add",
			textContent: "Add profile...",
		})
	);
	const list = $("profile-list");
	// Not rebuilt while a name is being typed.
	if (list.contains(document.activeElement)) return;
	list.replaceChildren(
		...s.profiles.map((p) => {
			const li = document.createElement("li");
			const name = document.createElement("input");
			name.type = "text";
			name.value = p.name;
			name.maxLength = 40;
			name.setAttribute("aria-label", "Profile name");
			name.onchange = () => void call("profile:rename", { id: p.id, name: name.value });
			const addr = document.createElement("span");
			addr.className = "muted";
			addr.textContent = `${p.active ? "Active. " : ""}${p.address}`;
			const use = document.createElement("button");
			use.textContent = "Switch";
			use.disabled = p.active;
			use.onclick = () => void call("profile:switch", { id: p.id });
			const rm = document.createElement("button");
			rm.textContent = "Remove...";
			rm.onclick = () => void call("profile:remove", { id: p.id });
			li.append(name, addr, use, rm);
			return li;
		})
	);
}

function reportLayout() {
	if (!state || !state.panel.open) return;
	const r = $("browser-rect").getBoundingClientRect();
	void call("browser:layout", {
		x: Math.round(r.x),
		y: Math.round(r.y),
		width: Math.round(r.width),
		height: Math.round(r.height),
		visible: state.panel.pane === "browser" && r.width > 0,
	});
}

/** galopin's output, kept whole; shown de-duplicated (a repeated line once, with a count). */
let logLines: string[] = [];
let logShown = false;
let busy: string | null = null;
function log(line: string) {
	logLines = [...logLines.slice(-499), line];
	// While pairing or signing in, galopin's own words (a link to open, a code to type) are the news.
	if ((busy === "pair" || busy === "sign in") && !line.startsWith("$"))
		$("g-detail").textContent = line;
	if (logShown) renderLog();
	scheduleInfo();
}
function renderLog() {
	const out = $("g-out");
	out.textContent = dedupeLog(logLines)
		.map((l) => (l.count > 1 ? `${l.text}  (x${l.count})` : l.text))
		.join("\n");
	out.scrollTop = out.scrollHeight;
}
async function run(label: string, p: Promise<unknown>) {
	busy = label;
	try {
		const r = await p;
		if (typeof r === "string" && r) log(r);
	} catch (e) {
		log(`${label}: ${msg(e)}`);
	} finally {
		busy = null;
	}
	scheduleInfo();
}

let info: GalopinInfo | undefined;
let infoTimer: ReturnType<typeof setTimeout> | undefined;
/** One fetch for any burst of changes, and only while the galopin tab is showing. */
function scheduleInfo() {
	if (!state?.panel.open || state.panel.pane !== "galopin") return;
	clearTimeout(infoTimer);
	infoTimer = setTimeout(async () => {
		try {
			info = (await call("galopin:info")) as GalopinInfo;
			renderGalopin();
		} catch {
			// the tab shows what it had
		}
	}, 250);
}

function renderGalopin() {
	const i = info;
	if (!i || !state) return;
	const available = state.galopin.available;
	const headline = $("g-headline");
	const detail = $("g-detail");
	const primary = $<HTMLButtonElement>("g-primary");
	const options = $("g-pair-options");
	let action: (() => void) | undefined;
	options.hidden = true;
	primary.hidden = false;
	primary.disabled = false;
	if (!available) {
		headline.textContent = "galopin is not installed with this app.";
		detail.textContent = "";
		primary.hidden = true;
	} else if (i.pairing === "other") {
		headline.textContent = "Paired with another server";
		detail.textContent = `This computer is paired with ${i.otherAddress}, not this profile's server (${i.serverName}). That pairing is left as it is.`;
		primary.textContent = "Pair for this profile";
		options.hidden = false;
		action = pair;
	} else if (i.pairing === "none") {
		headline.textContent = `Not paired with ${i.serverName}`;
		detail.textContent =
			"Pairing lets this server use files, connectors and a browser on this computer.";
		primary.textContent = "Pair this computer";
		options.hidden = false;
		action = pair;
	} else if (i.signIn === "expired") {
		headline.textContent = "Sign-in expired";
		detail.textContent = `This computer's sign-in to ${i.serverName} ended. Sign in again to carry on; nothing else changes.`;
		primary.textContent = "Sign in again";
		action = () => void run("sign in", call("galopin:signin"));
	} else if (i.running) {
		headline.textContent = `Paired with ${i.serverName}. Running`;
		detail.textContent = "Cerea can reach this computer while the app is open.";
		primary.textContent = "Stop";
		action = () => void run("stop", call("galopin:stop"));
	} else {
		headline.textContent = `Paired with ${i.serverName}. Stopped`;
		detail.textContent = "Cerea cannot reach this computer until galopin starts.";
		primary.textContent = "Start";
		action = () => void run("start", call("galopin:start"));
	}
	primary.onclick = () => action?.();

	const list = $("g-tools-list");
	list.replaceChildren(
		...i.tools.map((t) => {
			const li = document.createElement("li");
			li.className = t.installed ? "" : "absent";
			const name = document.createElement("span");
			name.textContent = t.installed ? t.label : `${t.label} (not installed)`;
			li.append(name);
			if (t.installed) {
				const right = document.createElement("span");
				right.className = "row";
				const launch = document.createElement("button");
				launch.textContent = "Launch";
				launch.onclick = () => void run("launch", call("galopin:launch", { tool: t.tool }));
				const label = document.createElement("label");
				label.hidden = !i.ownsDefault; // the shims follow the default pairing: only its owner switches them
				const sw = document.createElement("input");
				sw.type = "checkbox";
				sw.checked = t.byDefault;
				sw.onchange = () =>
					void run(
						"setup",
						call("galopin:setup", { tool: t.tool, remove: !sw.checked, makeDefault: sw.checked })
					);
				label.append(sw, " Use galopin by default");
				right.append(launch, label);
				li.append(right);
				if (t.byDefault && i.ownsDefault) {
					const note = document.createElement("span");
					note.className = "muted note";
					note.textContent = `To use it, put ${i.shimDir} first on your PATH.`;
					li.append(note);
				}
			}
			return li;
		})
	);

	const note = $("g-tools-note");
	note.hidden = i.ownsDefault;
	note.textContent = i.ownsDefault
		? ""
		: i.defaultOwner
			? `Coding tools started by default use the pairing of ${i.defaultOwner}, not this profile's.`
			: "Coding tools started by default use galopin's own pairing, not this profile's.";
	$("g-browser-status").textContent = i.browser.configured
		? "The browser is set up: Cerea can use it."
		: "Not set up. Lets Cerea use a browser on this computer.";
	$("g-browser").textContent = i.browser.configured ? "Set up again" : "Set up browser";
	$("g-conn-status").textContent =
		i.connectors === 0
			? "No connectors yet. They give Cerea your own tools and files."
			: `${i.connectors} connector${i.connectors === 1 ? "" : "s"}.`;
	$<HTMLInputElement>("g-service").checked = i.service.installed;
	$("g-service-status").textContent = i.service.installed
		? "galopin starts when you log in and keeps running after the app is closed."
		: "galopin runs only while the app is open.";
	$("g-version").textContent = `galopin updates with the app (${i.version || "version unknown"}).`;
}

function pair() {
	const agent = $<HTMLInputElement>("p-agent");
	const checked = (id: string) => $<HTMLInputElement>(id).checked || undefined;
	const roots = $<HTMLTextAreaElement>("p-roots")
		.value.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const flow = $<HTMLSelectElement>("p-flow").value as "auto" | "device" | "loopback";
	const arg = agent.checked
		? {
				agent: true,
				engine: $<HTMLSelectElement>("p-engine").value as "opencode" | "goose" | "vibe",
				flow,
				defaultGroup: checked("p-default-group"),
				noTerminal: checked("p-no-terminal"),
				noFiles: checked("p-no-files"),
				allowFileWrite: checked("p-file-write"),
				allowProjectConfig: checked("p-project-config"),
				...(roots.length ? { workspaceRoots: roots } : {}),
			}
		: { agent: false, flow };
	void run("pair", call("galopin:pair", JSON.parse(JSON.stringify(arg))));
}

function card(prefix: "setup" | "switch", info: ServerInfo | undefined) {
	show($(`${prefix}-card`), !!info);
	if (!info) return;
	$(`${prefix}-name`).textContent = info.name;
	$(`${prefix}-url`).textContent = info.address;
	if (prefix === "setup") {
		const img = $<HTMLImageElement>("setup-icon");
		img.hidden = !info.icon;
		if (info.icon) img.src = info.icon;
	}
}

function wire() {
	for (const b of document.querySelectorAll<HTMLButtonElement>("#bar [data-pane]")) {
		b.onclick = () => {
			const want = b.dataset.pane as "browser" | "galopin" | "server";
			const showing = !!state?.panel.open && state.panel.pane === want;
			void call("panel:set", { open: !showing, pane: want });
		};
	}
	$<HTMLInputElement>("s-login").onchange = (e) =>
		void call("app:login", { enabled: (e.target as HTMLInputElement).checked });
	$("open-cerea").onclick = () => void call("app:open-cerea");
	$("setup-form").onsubmit = async (e) => {
		e.preventDefault();
		$("setup-error").textContent = "";
		candidate = undefined;
		card("setup", undefined);
		try {
			candidate = (await call("server:probe", {
				address: $<HTMLInputElement>("setup-address").value,
			})) as ServerInfo;
			card("setup", candidate);
		} catch (err) {
			$("setup-error").textContent = msg(err);
		}
	};
	$("setup-use").onclick = async () => {
		if (!candidate) return;
		try {
			await call("profile:add", { address: candidate.address });
		} catch (err) {
			$("setup-error").textContent = msg(err);
		}
	};
	$("switch-form").onsubmit = async (e) => {
		e.preventDefault();
		$("switch-error").textContent = "";
		switchCandidate = undefined;
		card("switch", undefined);
		try {
			switchCandidate = (await call("server:probe", {
				address: $<HTMLInputElement>("switch-address").value,
			})) as ServerInfo;
			card("switch", switchCandidate);
		} catch (err) {
			$("switch-error").textContent = msg(err);
		}
	};
	$("switch-go").onclick = async () => {
		if (!switchCandidate) return;
		try {
			await call("profile:add", { address: switchCandidate.address });
			card("switch", undefined);
			$<HTMLInputElement>("switch-address").value = "";
		} catch (err) {
			$("switch-error").textContent = msg(err);
		}
	};
	const sel = $<HTMLSelectElement>("profile-select");
	sel.onchange = () => {
		if (sel.value === "__add") {
			void call("panel:set", { open: true, pane: "server" }).then(() =>
				$<HTMLInputElement>("switch-address").focus()
			);
			return;
		}
		void call("profile:switch", { id: sel.value }).catch((err) => log(`switch: ${msg(err)}`));
	};
	$("nav-back").onclick = () => void call("browser:nav", { action: "back" });
	$("nav-forward").onclick = () => void call("browser:nav", { action: "forward" });
	$("nav-reload").onclick = () => void call("browser:nav", { action: "reload" });
	$("browser-form").onsubmit = (e) => {
		e.preventDefault();
		const input = $<HTMLInputElement>("browser-address");
		if (input.value.trim()) void call("browser:open", { url: input.value });
		input.value = "";
	};
	$("g-browser").onclick = () => void run("browser", call("galopin:browser-setup"));
	$("g-connectors").onclick = () => void run("connectors", call("galopin:edit-connectors"));
	const service = $<HTMLInputElement>("g-service");
	service.onchange = () =>
		void run(
			"service",
			call("galopin:service", { action: service.checked ? "install" : "uninstall" })
		).then(() => scheduleInfo());
	const agent = $<HTMLInputElement>("p-agent");
	agent.onchange = () => show($("p-agent-opts"), agent.checked);
	$("g-showlog").onclick = () => {
		logShown = !logShown;
		$("g-showlog").textContent = logShown ? "Hide log" : "Show log";
		$("g-showlog").setAttribute("aria-expanded", String(logShown));
		show($("g-out"), logShown);
		show($("g-copylog"), logShown);
		if (logShown) renderLog();
	};
	$("g-copylog").onclick = () =>
		void call("app:copy", {
			text: dedupeLog(logLines)
				.map((l) => (l.count > 1 ? `${l.text}  (x${l.count})` : l.text))
				.join("\n"),
		});
	window.addEventListener("resize", reportLayout);
	$("side-close").onclick = () => void call("panel:set", { open: false });
	// The divider between the chat and the side area: drag to resize, double-click for the default
	// width, arrow keys when it is focused. The HTML panel follows the pointer at once; main moves the
	// native views to the same width right after.
	const handle = $("side-handle");
	let dragging = false;
	let startX = 0;
	let startWidth = 0;
	const setWidth = (w: number) => {
		document.documentElement.style.setProperty("--side-w", `${Math.round(w)}px`);
		void call("panel:set", { width: w });
	};
	handle.onpointerdown = (e) => {
		dragging = true;
		startX = e.clientX;
		startWidth = state?.panel.width ?? 440;
		// Captured: the moves keep coming here even over the native views beside it.
		handle.setPointerCapture(e.pointerId);
		handle.classList.add("dragging");
		e.preventDefault();
	};
	handle.onpointermove = (e) => {
		if (dragging) setWidth(startWidth + (startX - e.clientX));
	};
	handle.ondblclick = () => void call("panel:set", { width: 0 });
	handle.onkeydown = (e) => {
		const w = state?.panel.width ?? 440;
		const step = e.shiftKey ? 80 : 20;
		if (e.key === "ArrowLeft") (e.preventDefault(), setWidth(w + step));
		else if (e.key === "ArrowRight") (e.preventDefault(), setWidth(w - step));
		else if (e.key === "Home") (e.preventDefault(), void call("panel:set", { width: 0 }));
	};
	handle.onpointerup = handle.onpointercancel = (e) => {
		dragging = false;
		handle.releasePointerCapture(e.pointerId);
		handle.classList.remove("dragging");
	};
	// Hidden: nothing animates, and nothing is asked for. Shown again: look once.
	document.addEventListener("visibilitychange", () => {
		document.body.classList.toggle("hidden", document.hidden);
		if (!document.hidden)
			void call("app:state").then((s) => {
				state = s as AppState;
				render();
			});
	});
	new ResizeObserver(reportLayout).observe($("browser-rect"));
	window.cerea.on("state", (s) => {
		state = s as AppState;
		render();
	});
	window.cerea.on("output", (l) => log(String(l)));
	// A task from the chat in this window started (ADR 0122): show the browser panel.
	// TODO: use the "panel opens as a tool" hook of fix/desktop-browser-panel once it is merged.
	window.cerea.on("agent-active", () => {
		if (pane === "browser" || !state?.server) return;
		pane = "browser";
		render();
		reportLayout();
	});
}

wire();
void call("app:state").then((s) => {
	state = s as AppState;
	render();
});
