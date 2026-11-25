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
let pane: "browser" | "galopin" | "server" | null = "browser";
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
	show($("setup"), first);
	show($("side"), !first && pane !== null);
	for (const b of document.querySelectorAll<HTMLButtonElement>("#bar [data-pane]")) {
		b.hidden = first;
		b.setAttribute("aria-pressed", String(b.dataset.pane === pane));
	}
	$("open-cerea").hidden = first;
	$("server-name").textContent = s.server?.name ?? "Cerea";
	const logo = $<HTMLImageElement>("logo");
	logo.hidden = !s.server?.icon;
	if (s.server?.icon) logo.src = s.server.icon;
	for (const p of ["browser", "galopin", "server"] as const) show($(`pane-${p}`), pane === p);

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
	$("s-current").textContent = s.server ? `${s.server.name} (${s.server.address})` : "";

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

function reportLayout() {
	if (!state) return;
	const first = !state.server;
	const sideOpen = !first && pane !== null;
	const r = $("browser-rect").getBoundingClientRect();
	void call("browser:layout", {
		x: Math.round(r.x),
		y: Math.round(r.y),
		width: Math.round(r.width),
		height: Math.round(r.height),
		visible: sideOpen && pane === "browser" && r.width > 0,
		sideWidth: first
			? window.innerWidth
			: sideOpen
				? Math.round($("side").getBoundingClientRect().width)
				: 0,
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
			pane = pane === b.dataset.pane ? null : (b.dataset.pane as typeof pane);
			render();
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
			await call("server:set", { address: candidate.address });
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
			const r = await call("server:switch", { address: switchCandidate.address, confirm: true });
			if (r) card("switch", undefined);
		} catch (err) {
			$("switch-error").textContent = msg(err);
		}
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
