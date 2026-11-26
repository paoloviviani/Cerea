import type { AppState, Calls, ServerInfo } from "../shared/ipc.ts";

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
const TOOLS = ["opencode", "goose", "vibe", "claude"] as const;

function show(el: HTMLElement, on: boolean) {
	el.hidden = !on;
}

function render() {
	if (!state) return;
	const s = state;
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

	// galopin
	const g = s.galopin;
	$("g-status").textContent = !g.available
		? "galopin is not installed with this app."
		: `${g.paired ? `Paired with ${g.pairedAddress || "your Cerea"}` : "Not paired"}. galopin is ${g.running ? "running" : "stopped"}.`;
	$<HTMLButtonElement>("g-start").disabled = !g.available || g.running || !g.paired;
	$<HTMLButtonElement>("g-stop").disabled = !g.running;
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

function log(line: string) {
	const out = $("g-out");
	out.textContent += (out.textContent ? "\n" : "") + line;
	out.scrollTop = out.scrollHeight;
}
async function run(label: string, p: Promise<unknown>) {
	try {
		const r = await p;
		if (typeof r === "string" && r) log(r);
	} catch (e) {
		log(`${label}: ${msg(e)}`);
	}
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
	$("g-start").onclick = () => void call("galopin:start");
	$("g-stop").onclick = () => void call("galopin:stop");
	$("g-status-btn").onclick = () => void run("status", call("galopin:status"));
	$("g-upgrade").onclick = () => void run("upgrade", call("galopin:upgrade", { show: false }));
	$("g-browser").onclick = () => void run("browser", call("galopin:browser-setup"));
	$("g-connectors").onclick = () => void run("connectors", call("galopin:edit-connectors"));
	$("g-svc-install").onclick = () =>
		void run("service", call("galopin:service", { action: "install" }));
	$("g-svc-uninstall").onclick = () =>
		void run("service", call("galopin:service", { action: "uninstall" }));
	$("g-svc-status").onclick = () =>
		void run("service", call("galopin:service", { action: "status" }));
	const agent = $<HTMLInputElement>("p-agent");
	agent.onchange = () => show($("p-agent-opts"), agent.checked);
	const checked = (id: string) => $<HTMLInputElement>(id).checked || undefined;
	$("p-go").onclick = () => {
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
	};
	const tools = $("g-tools");
	const setup = $("g-setup");
	for (const t of TOOLS) {
		const l = document.createElement("button");
		l.textContent = `launch ${t}`;
		l.onclick = () => void run("launch", call("galopin:launch", { tool: t }));
		tools.append(l);
		const on = document.createElement("button");
		on.textContent = `setup ${t}`;
		on.onclick = () =>
			void run("setup", call("galopin:setup", { tool: t, remove: false, makeDefault: false }));
		const off = document.createElement("button");
		off.textContent = `remove ${t}`;
		off.onclick = () =>
			void run("setup", call("galopin:setup", { tool: t, remove: true, makeDefault: false }));
		setup.append(on, off);
	}
	window.addEventListener("resize", reportLayout);
	$("side-close").onclick = () => void call("panel:set", { open: false });
	// The divider between the chat and the side area: drag to resize, double-click for the default
	// width, arrow keys when it is focused. The HTML panel follows the pointer at once; main moves the
	// native views to the same width right after.
	const handle = $("side-handle");
	let dragging = false;
	const setWidth = (w: number) => {
		document.documentElement.style.setProperty("--side-w", `${Math.round(w)}px`);
		void call("panel:set", { width: w });
	};
	handle.onpointerdown = (e) => {
		dragging = true;
		// Captured: the moves keep coming here even over the native views beside it.
		handle.setPointerCapture(e.pointerId);
		handle.classList.add("dragging");
		e.preventDefault();
	};
	handle.onpointermove = (e) => {
		if (dragging) setWidth(window.innerWidth - e.clientX);
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
}

wire();
void call("app:state").then((s) => {
	state = s as AppState;
	render();
});
