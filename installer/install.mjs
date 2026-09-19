#!/usr/bin/env node
/*
 * The Cerea + Pystino installer: the main entry point for a new deployment.
 *
 * Zero runtime dependencies — raw ANSI plus readline — so it runs against a
 * fresh clone before `npm install`. Run it with plain node:
 *
 *   node installer/install.mjs [--pystino <path>] [--phase2]
 *
 * What it does, in order: validates (or clones) the Pystino checkout, proposes
 * the three deployment profiles, lets the operator toggle components within
 * the chosen profile, generates every secret locally, writes Pystino's
 * deploy/.env from the matching profile fragment, then brings the stack up in
 * two phases (postgres + gateway first, because the catalogue key, the admin
 * password and the chat database cannot exist before it runs; everything else
 * second). `--phase2` resumes against an existing deploy/.env.
 *
 * Three rules this file never breaks, each learned the hard way upstream:
 *
 * - It never sources deploy/.env into its own shell. One chat variable holds
 *   JSON and bash quote removal mangles it; compose prefers the shell
 *   environment over --env-file, so a sourced variable silently wins over the
 *   file. Compose children are spawned with every managed variable scrubbed
 *   from their environment (see cleanEnv), and the file travels only via
 *   --env-file.
 * - It never guesses a repository location. CHAT_REPO defaults to the
 *   checkout this script runs from and is always shown for confirmation; the
 *   Pystino path is asked for, validated, or cloned on request.
 * - It never regenerates a secret silently. On resume, existing values are
 *   kept — rotating GATEWAY_SECRET_KEY would destroy every stored provider
 *   credential, and rotating the placeholder key would re-label every
 *   transcript entity.
 */
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";

const CEREA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_FORK = "https://github.com/paoloviviani/Pystino.git";

/* ------------------------------------------------------------------ */
/* small terminal kit: ANSI colors, prompts, menus                     */
/* ------------------------------------------------------------------ */

const ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	cyan: "\x1b[36m",
};

function paint(text, color) {
	return process.stdout.isTTY ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

function title(text) {
	console.log(`\n${paint(`== ${text} ==`, "bold")}`);
}

function note(text) {
	console.log(paint(text, "dim"));
}

function warn(text) {
	console.log(paint(`! ${text}`, "yellow"));
}

function fail(text) {
	console.error(paint(`error: ${text}`, "red"));
	process.exit(1);
}

function makeInterface() {
	const io = readline.createInterface({ input: process.stdin, output: process.stdout });
	io.on("SIGINT", () => {
		console.log("\nAborted. Nothing was changed beyond what the transcript above says.");
		process.exit(130);
	});
	io.on("close", () => {
		/* A closed stdin with a question pending would otherwise hang, or —
		 * worse — drain the event loop and exit 0 mid-flow, looking like
		 * success. Fail loudly instead. Disarmed by finish() below once the
		 * installer closes the interface itself. */
		if (!inputFinished) {
			fail(
				"input ended unexpectedly. Re-run interactively; nothing was written unless the transcript above says so."
			);
		}
	});
	return io;
}

let inputFinished = false;

/* Input abstraction with one job the raw interface lacks: piped (non-TTY)
 * stdin must work line by line AND fail loudly at EOF, never hang or exit 0
 * mid-flow. On a TTY this is plain readline; off one, lines are read upfront
 * and served from a queue with the answer echoed for transcript fidelity. */
function makeInput() {
	if (process.stdin.isTTY) {
		const io = makeInterface();
		return {
			question: (text) => new Promise((resolve) => io.question(text, resolve)),
			close: () => io.close(),
		};
	}
	const lines = fs.readFileSync(0, "utf8").split("\n");
	let i = 0;
	return {
		question: (text) => {
			process.stdout.write(text);
			if (i >= lines.length || (i === lines.length - 1 && lines[i] === "")) {
				return Promise.resolve(null);
			}
			const line = lines[i++];
			console.log(line);
			return Promise.resolve(line);
		},
		close: () => {},
	};
}

function endOfInput() {
	fail(
		"input ended unexpectedly. Re-run interactively; nothing was written unless the transcript above says so."
	);
}

function ask(io, question, def) {
	const suffix = def !== undefined && def !== "" ? ` [${def}]` : "";
	return io.question(`${question}${suffix}: `).then((answer) => {
		if (answer === null) endOfInput();
		const trimmed = answer.trim();
		return trimmed === "" ? (def ?? "") : trimmed;
	});
}

async function askRequired(io, question, def) {
	for (;;) {
		const value = await ask(io, question, def);
		if (value !== "") return value;
		console.log(paint("A value is required here.", "yellow"));
	}
}

/* A prompt that does not echo, for secrets the operator pastes. On a TTY this
 * uses raw mode; off one (a piped answer) it falls back to a visible prompt
 * with a warning. */
function askHidden(io, question) {
	if (process.stdin.isTTY) {
		return new Promise((resolve) => {
			const stdin = process.stdin;
			const prevRaw = stdin.isRaw;
			stdin.setRawMode(true);
			stdin.resume();
			process.stdout.write(`${question}: `);
			let value = "";
			const onData = (chunk) => {
				const char = chunk.toString("utf8");
				if (char === "\n" || char === "\r" || char === "") {
					stdin.setRawMode(prevRaw);
					stdin.pause();
					stdin.removeListener("data", onData);
					process.stdout.write("\n");
					resolve(value.trim());
				} else if (char === "" || char === "\b") {
					value = value.slice(0, -1);
				} else if (char === "") {
					process.stdout.write("\n");
					process.exit(130);
				} else {
					value += char;
				}
			};
			stdin.on("data", onData);
		});
	}
	warn("stdin is not a TTY — the value will echo.");
	return io.question(`${question}: `).then((answer) => {
		if (answer === null) endOfInput();
		return answer.trim();
	});
}

async function choose(io, question, options) {
	for (;;) {
		console.log(`\n${question}`);
		options.forEach((opt, i) => {
			console.log(`  ${paint(`${i + 1})`, "cyan")} ${opt.label}`);
			if (opt.detail) note(`     ${opt.detail}`);
		});
		const answer = await ask(io, `Choose [1-${options.length}]`, "1");
		const n = Number.parseInt(answer, 10);
		if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
		console.log(paint(`Enter a number between 1 and ${options.length}.`, "yellow"));
	}
}

async function confirm(io, question, defYes = true) {
	const hint = defYes ? "Y/n" : "y/N";
	for (;;) {
		const answer = (await ask(io, `${question} (${hint})`)).toLowerCase();
		if (answer === "") return defYes;
		if (["y", "yes"].includes(answer)) return true;
		if (["n", "no"].includes(answer)) return false;
		console.log(paint("Answer y or n.", "yellow"));
	}
}

/* ------------------------------------------------------------------ */
/* profiles, components, footprints                                    */
/* ------------------------------------------------------------------ */

/* Measured on the live host, September 2026 (docker stats, docker images).
 * RSS first, image size second. Shown at selection time so an operator sees
 * what each component costs before paying it. */
const FOOTPRINTS = {
	core: {
		rss: "~625 MB",
		disk: "~3.8 GB",
		label: "gateway + chat + mongo + postgres + valkey + proxy",
	},
	redactionPattern: {
		rss: "+~300 MB",
		disk: "+~1.9 GB image",
		label: "pattern-only redaction + local extractor",
	},
	redactionNer: {
		rss: "+~750 MB",
		disk: "same image, model weights inside",
		label: "NER redaction",
	},
	playwright: { rss: "+~175 MB", disk: "+3.45 GB image", label: "headless-browser fetch backend" },
};

const PROFILES = {
	homelab: {
		fragment: "homelab.env",
		name: "homelab",
		blurb: "Single box. No ledger, no redaction, local sign-in + house IdP.",
		footprint: `${FOOTPRINTS.core.rss} RSS, ${FOOTPRINTS.core.disk} disk, 2 vCPU`,
		defaults: {
			redaction: "off",
			fetch: "direct",
			metering: false,
			codeTool: true,
			usage: false,
			knowledge: true,
		},
	},
	team: {
		fragment: "team.env",
		name: "team",
		blurb: "Homelab plus accountability: ledger, quotas, pattern-only redaction.",
		footprint: `homelab ${FOOTPRINTS.redactionPattern.rss} RSS (${FOOTPRINTS.redactionPattern.label})`,
		defaults: {
			redaction: "pattern",
			fetch: "direct",
			metering: true,
			codeTool: true,
			usage: true,
			knowledge: true,
		},
	},
	enterprise: {
		fragment: "enterprise.env",
		name: "enterprise",
		blurb: "Everything: NER redaction, browser fetch, external OIDC, per-group billing.",
		footprint: `team ${FOOTPRINTS.redactionNer.rss} RSS, ${FOOTPRINTS.playwright.disk} for the browser`,
		defaults: {
			redaction: "ner",
			fetch: "playwright",
			metering: true,
			codeTool: true,
			usage: true,
			knowledge: true,
		},
	},
};

/* Every secret the installer manages. `generate` matches the generation
 * command deploy/.env.example documents for the same variable. `durability`
 * is shown in the UI at generation time — never only as a file comment. */
const SECRET_SPECS = [
	{ key: "POSTGRES_PASSWORD", generate: () => tokenUrlSafe(32) },
	{
		key: "GATEWAY_SECRET_KEY",
		generate: () => tokenUrlSafe(48),
		durability:
			"Encrypts provider credentials at rest. Back it up WITH the database — losing every value means re-entering each provider credential by hand, and rotating it orphans everything stored under the old one.",
	},
	{ key: "GATEWAY_SESSION_SECRET", generate: () => tokenUrlSafe(48) },
	{
		key: "REDACTION_PLACEHOLDER_KEY",
		generate: () => tokenUrlSafe(32),
		durability:
			"Must stay stable for as long as the transcripts it labelled are kept: rotating it re-labels every entity, so old placeholders stop matching.",
	},
	{ key: "GATEWAY_IDP__INTERNAL_TOKEN", generate: () => tokenUrlSafe(48) },
	{ key: "GATEWAY_IDP__SIGNING_KEY", generate: generateIdpSigningKey },
	{ key: "CHAT_IDP_CLIENT_SECRET", generate: () => tokenUrlSafe(48) },
	{ key: "CHAT_SECRET_KEY", generate: () => tokenUrlSafe(48) },
	{ key: "CHAT_PG_PASSWORD", generate: () => tokenUrlSafe(32), internal: true },
];

function tokenUrlSafe(nBytes) {
	/* secrets.token_urlsafe(n): urlsafe base64 without padding, n random bytes. */
	return crypto.randomBytes(nBytes).toString("base64url");
}

function generateIdpSigningKey() {
	/* deploy/.env.example documents `openssl ecparam -genkey -name
	 * prime256v1`. Prefer the documented command; fall back to node's own
	 * P-256 in SEC1 PEM, which is the same bytes in the same envelope. */
	const probe = spawnSync("openssl", ["ecparam", "-genkey", "-name", "prime256v1"], {
		encoding: "utf8",
	});
	if (probe.status === 0 && probe.stdout.includes("BEGIN EC PRIVATE KEY"))
		return probe.stdout.trim() + "\n";
	const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
	return privateKey.export({ type: "sec1", format: "pem" }).trim() + "\n";
}

/* ------------------------------------------------------------------ */
/* validation helpers                                                  */
/* ------------------------------------------------------------------ */

function isAbsoluteUrl(value) {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function validatePystinoRoot(dir) {
	const missing = [
		"deploy/compose/docker-compose.yml",
		"deploy/profiles/overlays.sh",
		"deploy/profiles/homelab.env",
	].filter((rel) => !fs.existsSync(path.join(dir, rel)));
	return missing;
}

function checkDocker() {
	const probe = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
	if (probe.status !== 0)
		fail("docker compose is not available. Install Docker (with the compose plugin) and re-run.");
}

/* Parse KEY=VALUE lines (no interpolation, no sourcing — values travel to
 * compose only via --env-file). Multiline values (the IdP signing-key PEM)
 * reattach to their KEY= line: continuation lines are anything that is not
 * blank, a comment, a PEM END marker's... — the mirror of buildEnvLines'
 * span rule, because a resume that truncated the key would then write the
 * truncation back and destroy the original. Returns { order, values }. */
function parseEnvFile(filePath) {
	const spanEnds = (line) =>
		/^\s*(#|$|-----END )/.test(line) || /^\s*[A-Z][A-Z0-9_]{2,}\s*=/.test(line);
	const order = [];
	const values = new Map();
	let current = null;
	for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
		const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
		if (match && (current === null || spanEnds(line))) {
			current = match[1];
			if (!values.has(current)) order.push(current);
			values.set(current, match[2]);
		} else if (current !== null && /^\s*-----END /.test(line)) {
			/* The PEM END marker belongs to the value, then closes it. */
			values.set(current, `${values.get(current)}\n${line}`);
			current = null;
		} else if (current !== null && !spanEnds(line)) {
			values.set(current, `${values.get(current)}\n${line}`);
		} else {
			current = null;
		}
	}
	return { order, values };
}

/* ------------------------------------------------------------------ */
/* compose: always --env-file, never the shell environment             */
/* ------------------------------------------------------------------ */

/* Compose prefers same-named shell variables over --env-file, so a stray
 * export would silently win over the file just written. Children therefore
 * run with every managed variable scrubbed. This is also what keeps a JSON
 * chat variable in the operator's shell from ever reaching the stack. */
function cleanEnv(managedKeys) {
	const env = { ...process.env };
	for (const key of managedKeys) delete env[key];
	return env;
}

function composeArgs(pystinoRoot, envFile, overlayFlags, rest) {
	return ["compose", "--env-file", envFile, ...overlayFlags, ...rest];
}

function runCompose(pystinoRoot, envFile, managedKeys, overlayFlags, rest, opts = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", composeArgs(pystinoRoot, envFile, overlayFlags, rest), {
			cwd: pystinoRoot,
			env: cleanEnv(managedKeys),
			stdio: opts.input !== undefined ? ["pipe", "inherit", "inherit"] : "inherit",
		});
		if (opts.input !== undefined && child.stdin) {
			/* A child that exits without draining stdin (a stubbed docker in
			 * tests) raises EPIPE on write — swallow it; the exit code below
			 * is what the caller decides on. */
			child.stdin.on("error", () => {});
			child.stdin.write(opts.input);
			child.stdin.end();
		}
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`docker compose ${rest.join(" ")} exited with ${code}`));
		});
	});
}

/* Ask overlays.sh for the -f list. The installer never restates the mapping:
 * profile sets go through profile_overlays, deviated sets through
 * custom_overlays. Shell-quoting is avoided by construction — overlays.sh
 * prints one -f path pair per two words and paths contain no spaces (CHAT_REPO
 * with a space is refused at validation). */
function overlayFlags(pystinoRoot, managedKeys, mode, ...args) {
	const script = path.join(pystinoRoot, "deploy/profiles/overlays.sh");
	const probe = spawnSync("sh", ["-c", `. "${script}" && ${mode} ${args.join(" ")}`], {
		cwd: pystinoRoot,
		env: cleanEnv(managedKeys),
		encoding: "utf8",
	});
	if (probe.status !== 0)
		fail(`overlays.sh refused the selection: ${(probe.stderr || probe.stdout || "").trim()}`);
	return probe.stdout.trim().split(/\s+/).filter(Boolean);
}

function httpGet(url, timeoutMs = 4000) {
	return new Promise((resolve) => {
		const req = http.get(url, { timeout: timeoutMs }, (res) => {
			res.resume();
			resolve(res.statusCode);
		});
		req.on("timeout", () => {
			req.destroy();
			resolve(null);
		});
		req.on("error", () => resolve(null));
	});
}

async function waitForGateway(port, timeoutMs = 180000) {
	const deadline = Date.now() + timeoutMs;
	process.stdout.write("Waiting for the gateway");
	for (;;) {
		const status = await httpGet(`http://127.0.0.1:${port}/healthz`);
		if (status === 200) {
			console.log(" — healthy.");
			return;
		}
		if (Date.now() > deadline)
			fail("the gateway did not become healthy in time. Inspect with: docker compose logs gateway");
		process.stdout.write(".");
		await new Promise((r) => setTimeout(r, 3000));
	}
}

/* ------------------------------------------------------------------ */
/* .env assembly: profile fragment as the base, overrides on top       */
/* ------------------------------------------------------------------ */

function buildEnvLines(fragmentPath, overrides, additions) {
	/* The fragment stays the single source of defaults: its lines (comments
	 * included) pass through, overridden keys are replaced in place, and keys
	 * the fragment never had are appended under an installer section.
	 *
	 * Values may span lines (the IdP signing key is a PEM). When a replaced
	 * value is multiline, the stale continuation lines below it are dropped.
	 * A span ends at a blank line, a comment, a PEM END marker, or a new
	 * UPPER_SNAKE assignment of three or more characters — the length floor
	 * matters: a PEM tail line is base64 whose padding (`AB==`) matches a
	 * naive KEY= pattern, and real variable names are never that short. */
	const raw = fs.readFileSync(fragmentPath, "utf8").split("\n");
	const seen = new Set();
	const out = [];
	let droppingTail = false;
	const spanEnds = (line) =>
		/^\s*(#|$|-----END )/.test(line) || /^\s*[A-Z][A-Z0-9_]{2,}\s*=/.test(line);
	for (const line of raw) {
		if (droppingTail) {
			/* The stale END marker goes with its value, not after it. */
			if (/^\s*-----END /.test(line)) {
				droppingTail = false;
				continue;
			}
			if (!spanEnds(line)) continue;
			droppingTail = false;
		}
		const keyMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
		if (keyMatch && Object.prototype.hasOwnProperty.call(overrides, keyMatch[1])) {
			seen.add(keyMatch[1]);
			const replacement = `${keyMatch[1]}=${String(overrides[keyMatch[1]]).replace(/\n$/, "")}`;
			out.push(replacement);
			if (replacement.includes("\n")) droppingTail = true;
			continue;
		}
		out.push(line);
	}
	const missing = Object.keys(overrides).filter((k) => !seen.has(k));
	const extra = Object.entries(additions)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `${k}=${v}`)
		.filter((line) => {
			const key = line.split("=")[0];
			return !seen.has(key) && !raw.some((l) => l.match(new RegExp(`^\\s*${key}\\s*=`)));
		});
	if (missing.length > 0 || extra.length > 0) {
		out.push(
			"",
			"# --- installer additions ------------------------------------------------------"
		);
		out.push("# Values for toggles this fragment never had (a deviated component choice).");
		for (const key of missing) out.push(`${key}=${overrides[key]}`);
		out.push(...extra);
	}
	return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* the flow                                                            */
/* ------------------------------------------------------------------ */

async function ensurePystinoRoot(io, cliPath) {
	if (cliPath) {
		const resolved = path.resolve(cliPath);
		const missing = validatePystinoRoot(resolved);
		if (missing.length > 0)
			fail(`not a Pystino checkout: ${resolved} (missing ${missing.join(", ")})`);
		return resolved;
	}
	title("Pystino checkout");
	note(
		"The compose files and deploy/.env live in Pystino; this installer writes into that checkout."
	);
	for (;;) {
		const answer = await askRequired(io, "Path to the Pystino checkout");
		const resolved = path.resolve(answer.replace(/^~/, os.homedir()));
		if (!fs.existsSync(resolved)) {
			const clone = await confirm(
				io,
				"That path does not exist. Clone the internal fork there?",
				true
			);
			if (!clone) continue;
			const url = await ask(io, "Repository URL", INTERNAL_FORK);
			console.log(`Cloning ${url} ...`);
			const probe = spawnSync("git", ["clone", url, resolved], { stdio: "inherit" });
			if (probe.status !== 0) {
				warn("Clone failed. Check the URL and your access, then try again.");
				continue;
			}
		}
		const missing = validatePystinoRoot(resolved);
		if (missing.length > 0) {
			warn(`That directory is missing ${missing.join(", ")}. Pick another, or clone the fork.`);
			continue;
		}
		if (resolved.includes(" "))
			fail(
				"The Pystino path contains a space, which the overlay derivation cannot quote. Move the checkout and re-run."
			);
		return resolved;
	}
}

async function ensureChatRepo(io) {
	title("Chat checkout");
	note("The chat image builds from a local Cerea checkout — this one, unless you say otherwise.");
	for (;;) {
		const answer = await ask(io, "Path to the Cerea checkout", CEREA_ROOT);
		const resolved = path.resolve(answer.replace(/^~/, os.homedir()));
		if (!fs.existsSync(path.join(resolved, "Dockerfile"))) {
			warn("No Dockerfile there — that is not a Cerea checkout. Try again.");
			continue;
		}
		if (resolved.includes(" "))
			fail(
				"The Cerea path contains a space, which the compose derivation cannot quote. Move the checkout and re-run."
			);
		return resolved;
	}
}

async function chooseProfile(io) {
	title("Deployment profile");
	const keys = Object.keys(PROFILES);
	const idx = await choose(
		io,
		"One stack, three sizes. Exposure (edge or proxy) is chosen separately afterwards.",
		keys.map((k) => ({
			label: `${paint(k, "cyan")} — ${PROFILES[k].blurb}`,
			detail: `Footprint: ${PROFILES[k].footprint}`,
		}))
	);
	return keys[idx];
}

async function toggleComponents(io, profileKey) {
	const defaults = { ...PROFILES[profileKey].defaults };
	title(`Components — ${profileKey} defaults, toggle by number`);
	const state = { ...defaults };
	for (;;) {
		const redactionLabel = { off: "off", pattern: "pattern-only", ner: "NER" }[state.redaction];
		const rows = [
			{
				key: "redaction",
				label: `Redaction: ${redactionLabel}`,
				detail: `off: nothing (+0) · pattern: ${FOOTPRINTS.redactionPattern.rss} RSS, ${FOOTPRINTS.redactionPattern.disk} (${FOOTPRINTS.redactionPattern.label}) · NER: ${FOOTPRINTS.redactionNer.rss} RSS (${FOOTPRINTS.redactionNer.label}) — needs a rebuild to change later (SPACY_MODELS is a build argument)`,
			},
			{
				key: "fetch",
				label: `URL fetching: ${state.fetch}`,
				detail: `direct: plain HTTPS, JS pages arrive empty · playwright: rendered pages, ${FOOTPRINTS.playwright.rss} RSS + ${FOOTPRINTS.playwright.disk} (unauthenticated remote code execution by design — never published)`,
			},
			{
				key: "metering",
				label: `Metering (ledger + quotas): ${state.metering ? "on" : "off"}`,
				detail:
					"off is the ADR 0065 passthrough shape: no usage_records rows, ever. Quotas cannot stay on without it — the combination is refused at startup, so they toggle as one",
			},
			{
				key: "usage",
				label: `Usage & billing tab: ${state.usage ? "shown" : "hidden"}`,
				detail: `defaults to ${state.metering ? "shown (there is a ledger to read)" : "hidden (no ledger, nothing to read)"} — independently toggleable`,
			},
			{
				key: "codeTool",
				label: `Code tool (browser Pyodide sandbox): ${state.codeTool ? "on" : "off"}`,
				detail: "free: runs in the signed-in person's own browser, never on this box",
			},
			{
				key: "knowledge",
				label: `Knowledge pipeline: ${state.knowledge ? "on" : "off"}`,
				detail:
					"free: its Postgres is a second database on the gateway's instance, not a container — off hides the surface instead of erroring",
			},
		];
		console.log("\nCurrent selection:");
		rows.forEach((row, i) =>
			console.log(`  ${paint(`${i + 1})`, "cyan")} ${row.label}\n     ${paint(row.detail, "dim")}`)
		);
		console.log(`  ${paint(`${rows.length + 1})`, "cyan")} Done — continue with this selection`);
		const answer = await ask(io, `Toggle [1-${rows.length + 1}]`, `${rows.length + 1}`);
		const n = Number.parseInt(answer, 10);
		if (!Number.isInteger(n) || n < 1 || n > rows.length + 1) {
			console.log(paint(`Enter a number between 1 and ${rows.length + 1}.`, "yellow"));
			continue;
		}
		if (n === rows.length + 1) return state;
		const key = rows[n - 1].key;
		if (key === "redaction") {
			const order = ["off", "pattern", "ner"];
			state.redaction = order[(order.indexOf(state.redaction) + 1) % order.length];
		} else if (key === "fetch") {
			state.fetch = state.fetch === "direct" ? "playwright" : "direct";
		} else {
			state[key] = !state[key];
		}
		if (key === "metering" && !state.metering && state.usage) {
			note(
				"Metering off with the Usage tab shown is pointless (nothing to read) — hiding the tab too. Re-enable it above if you disagree."
			);
			state.usage = false;
		}
	}
}

async function chooseExposure(io) {
	title("Exposure");
	note("The chat publishes no port: loopback alone leaves it unreachable, so it is not offered.");
	const idx = await choose(io, "How does a browser reach this deployment?", [
		{
			label: "edge — NetBird (or equivalent) edge terminates TLS upstream",
			detail: "plain HTTP on loopback here; the edge's reverse proxy forwards to this box",
		},
		{
			label: "proxy — Caddy terminates TLS on this box",
			detail:
				"self-signed on an IP, or automatic Let's Encrypt on a name (needs ports 80+443 from the internet)",
		},
	]);
	return idx === 0 ? "edge" : "proxy";
}

function requiredKeysFor(profileKey, state, exposure) {
	/* Fail-closed validation runs against this list before anything is
	 * written or started: every name here must be non-empty in the final
	 * .env, or the installer stops with the list instead of a compose error
	 * three layers down. */
	const keys = [
		"POSTGRES_PASSWORD",
		"GATEWAY_SECRET_KEY",
		"GATEWAY_SESSION_SECRET",
		"GATEWAY_UPSTREAM__API_KEY",
		"CHAT_CATALOGUE_KEY",
		"CHAT_PG_URL",
		"CHAT_IDP_CLIENT_SECRET",
		"CHAT_SECRET_KEY",
		"CHAT_REPO",
		"PUBLIC_HOST",
		"PUBLIC_ORIGIN",
	];
	if (state.redaction !== "off") keys.push("REDACTION_PLACEHOLDER_KEY");
	if (profileKey === "enterprise") {
		keys.push(
			"GATEWAY_OIDC__ISSUER",
			"GATEWAY_OIDC__CLIENT_ID",
			"GATEWAY_OIDC__CLIENT_SECRET",
			"CHAT_OIDC_PROVIDER_URL",
			"CHAT_OIDC_CLIENT_ID",
			"CHAT_OIDC_CLIENT_SECRET"
		);
	} else {
		keys.push("GATEWAY_IDP__ISSUER", "GATEWAY_IDP__SIGNING_KEY", "GATEWAY_IDP__INTERNAL_TOKEN");
	}
	if (exposure === "proxy") keys.push("ACME_EMAIL");
	return keys;
}

async function collectValues(io, profileKey, state, exposure, existing) {
	/* existing: values parsed from a previous deploy/.env on resume — kept,
	 * never regenerated. Fresh installs generate everything generatable. */
	const values = {};
	const keep = (key) => existing?.get(key) ?? "";

	const secret = (spec) => {
		const kept = keep(spec.key);
		if (kept !== "") {
			values[spec.key] = kept;
			return { generated: false };
		}
		values[spec.key] = spec.generate();
		return { generated: true, durability: spec.durability };
	};

	title("Secrets — generated locally, never fetched");
	const generatedNotes = [];
	for (const spec of SECRET_SPECS.filter((s) => !s.internal)) {
		if (spec.key === "REDACTION_PLACEHOLDER_KEY" && state.redaction === "off") continue;
		if (spec.key.startsWith("GATEWAY_IDP__") && profileKey === "enterprise") continue;
		const result = secret(spec);
		if (result.generated) {
			generatedNotes.push(spec.key);
			if (result.durability) {
				console.log(
					`\n${paint(`Durability warning — ${spec.key}:`, "yellow")}\n${result.durability}`
				);
			}
		}
	}
	if (generatedNotes.length > 0)
		note(
			`\nGenerated: ${generatedNotes.join(", ")}. Asked-for values below; nothing leaves this box.`
		);
	else note("\nResuming: all existing secrets kept, none regenerated.");

	/* Operator-supplied values. */
	title("Deployment values");
	values.GATEWAY_UPSTREAM__BASE_URL = await ask(
		io,
		"Upstream OpenAI-compatible base URL",
		existing?.get("GATEWAY_UPSTREAM__BASE_URL") || "https://api.cortecs.ai/v1"
	);
	values.GATEWAY_UPSTREAM__API_KEY = await askHidden(
		io,
		"Upstream API key (your provider account — cannot be generated)"
	);
	while (values.GATEWAY_UPSTREAM__API_KEY === "") {
		console.log(paint("The gateway serves nothing without an upstream key.", "yellow"));
		values.GATEWAY_UPSTREAM__API_KEY = await askHidden(io, "Upstream API key");
	}

	if (exposure === "edge") {
		values.PUBLIC_HOST = await askRequired(
			io,
			"Public hostname browsers use (the edge terminates TLS for it)",
			keep("PUBLIC_HOST")
		);
		values.HTTPS_PORT = await ask(
			io,
			"Edge forward port on this box",
			keep("HTTPS_PORT") || "8443"
		);
		values.TLS_DIRECTIVE = "tls internal";
	} else {
		values.PUBLIC_HOST = await askRequired(
			io,
			"Public host — IP for self-signed, FQDN for Let's Encrypt",
			keep("PUBLIC_HOST")
		);
		const looksIp = /^\d+\.\d+\.\d+\.\d+$/.test(values.PUBLIC_HOST);
		values.HTTPS_PORT = await ask(
			io,
			"HTTPS port",
			keep("HTTPS_PORT") || (looksIp ? "8443" : "443")
		);
		if (looksIp) {
			values.TLS_DIRECTIVE = "tls internal";
			note(
				"IP address: Caddy issues from its own CA (browsers warn once). Let's Encrypt cannot issue for an IP."
			);
		} else {
			const auto = await confirm(
				io,
				"Obtain a Let's Encrypt certificate automatically? (needs ports 80+443 reachable)",
				true
			);
			values.TLS_DIRECTIVE = auto ? "" : "tls internal";
		}
		values.ACME_EMAIL = await ask(
			io,
			"ACME email (certificate expiry notices)",
			keep("ACME_EMAIL") || ""
		);
	}
	const defaultOrigin =
		keep("PUBLIC_ORIGIN") ||
		(values.HTTPS_PORT === "443"
			? `https://${values.PUBLIC_HOST}`
			: `https://${values.PUBLIC_HOST}:${values.HTTPS_PORT}`);
	values.PUBLIC_ORIGIN = await ask(
		io,
		"Public origin (every advertised URL is built from this)",
		defaultOrigin
	);
	if (!isAbsoluteUrl(values.PUBLIC_ORIGIN)) fail("PUBLIC_ORIGIN must be an absolute http(s) URL.");

	if (profileKey === "enterprise") {
		title("External identity provider");
		note(
			"docs/oidc-generic-provider.md has the per-provider checklist. The audience is what accepts the provider's tokens on /v1 — the chat calls the gateway as the user, so leaving it empty breaks signed-in inference."
		);
		values.GATEWAY_OIDC__ENABLED = "true";
		values.GATEWAY_OIDC__ISSUER = await askRequired(
			io,
			"OIDC issuer",
			keep("GATEWAY_OIDC__ISSUER")
		);
		values.GATEWAY_OIDC__CLIENT_ID = await askRequired(
			io,
			"Client id (gateway console)",
			keep("GATEWAY_OIDC__CLIENT_ID")
		);
		values.GATEWAY_OIDC__CLIENT_SECRET = await askHidden(io, "Client secret (gateway console)");
		values.GATEWAY_OIDC__GROUPS_CLAIM = await ask(
			io,
			"Groups claim",
			keep("GATEWAY_OIDC__GROUPS_CLAIM") || "groups"
		);
		values.GATEWAY_OIDC__ACCESS_TOKEN_AUDIENCE = await ask(
			io,
			"Access-token audience for /v1",
			keep("GATEWAY_OIDC__ACCESS_TOKEN_AUDIENCE") || ""
		);
		if (values.GATEWAY_OIDC__ACCESS_TOKEN_AUDIENCE === "") {
			warn(
				"No audience means API keys only on /v1: the chat's per-user calls (USE_USER_TOKEN) will fail. This is only correct for a key-driven deployment."
			);
			const proceed = await confirm(io, "Proceed without an audience?", false);
			if (!proceed)
				values.GATEWAY_OIDC__ACCESS_TOKEN_AUDIENCE = await askRequired(
					io,
					"Access-token audience for /v1"
				);
		}
		values.GATEWAY_IDP__ENABLED = "false";
		values.CHAT_OIDC_PROVIDER_URL = await ask(
			io,
			"Chat OIDC provider URL",
			keep("CHAT_OIDC_PROVIDER_URL") || values.GATEWAY_OIDC__ISSUER
		);
		values.CHAT_OIDC_CLIENT_ID = await askRequired(
			io,
			"Chat client id at the provider",
			keep("CHAT_OIDC_CLIENT_ID") || "cerea"
		);
		values.CHAT_OIDC_CLIENT_SECRET = await askHidden(io, "Chat client secret");
		values.CHAT_OIDC_SCOPES = await ask(
			io,
			"Chat OIDC scopes",
			keep("CHAT_OIDC_SCOPES") || "openid profile email"
		);
	} else {
		values.GATEWAY_OIDC__ENABLED = "false";
		values.GATEWAY_IDP__ENABLED = "true";
		values.GATEWAY_IDP__ISSUER = values.PUBLIC_ORIGIN;
		values.GATEWAY_IDP__INTERNAL_BASE_URL = "http://gateway:8000";
	}

	/* Chat Postgres credentials: generated here, role created in phase 1. */
	const chatPgPassword = keep("CHAT_PG_PASSWORD") || tokenUrlSafe(24);
	values.CHAT_PG_PASSWORD = chatPgPassword;
	values.CHAT_PG_URL = `postgresql://chat:${chatPgPassword}@postgres:5432/chat`;

	/* Toggle-derived deployment flags. */
	values.GATEWAY_ACCOUNTING__ENABLED = state.metering ? "true" : "false";
	values.GATEWAY_QUOTA__ENABLED = state.metering ? "true" : "false";
	values.GATEWAY_REDACTION__ENGINE = state.redaction === "off" ? "noop" : "http";
	values.FETCH_BACKEND = state.fetch;
	values.CHAT_CODE_TOOL_ENABLED = state.codeTool ? "true" : "";
	values.CHAT_USAGE_ENABLED = state.usage ? "true" : "";
	values.CHAT_KNOWLEDGE_ENABLED = state.knowledge ? "true" : "false";
	if (state.redaction !== "off") {
		values.SPACY_MODELS = state.redaction === "ner" ? "en_core_web_lg" : "";
		values.REDACTION_NLP_ENGINE = state.redaction === "ner" ? "spacy" : "disabled";
		values.REDACTION_LANGUAGE = "en";
		if (state.redaction === "ner") {
			note(
				'NER build: the Italian-name model (it_core_news_lg) is CC BY-NC-SA 3.0 — the default en_core_web_lg build stays MIT throughout. Add it later by rebuilding with SPACY_MODELS="en_core_web_lg it_core_news_lg".'
			);
		}
	}
	/* GATEWAY_SESSION_COOKIE_SECURE is deliberately not set here: it stays
	 * whatever the fragment says (false for homelab/team loopback shapes,
	 * true for enterprise), and the proxy overlay forces true at the
	 * container regardless. On plain http a Secure cookie is set and never
	 * sent back — a login that lands on a signed-out console with nothing in
	 * any log — so this is not a value to default behind the operator's back. */
	values.GATEWAY_LOCAL_AUTH__ENABLED = "true";
	values.GATEWAY_ENVIRONMENT = "production";
	values.GATEWAY_PORT = keep("GATEWAY_PORT") || "8000";
	return values;
}

function validateFinal(required, values) {
	const missing = required.filter((k) => (values[k] ?? "").trim() === "");
	if (missing.length > 0)
		fail(`refusing to continue with empty required values: ${missing.join(", ")}`);
	if (!isAbsoluteUrl(values.GATEWAY_IDP__ISSUER ?? "") && values.GATEWAY_IDP__ENABLED === "true") {
		fail("GATEWAY_IDP__ISSUER must be an absolute http(s) URL when the house IdP is on.");
	}
}

async function phaseOne(io, pystinoRoot, envFile, managedKeys, values) {
	title("Phase 1 — database, gateway, first credentials");
	const baseFlags = ["-f", "deploy/compose/docker-compose.yml"];
	console.log("Starting postgres, valkey, migrations and the gateway (base overlay only) ...");
	await runCompose(pystinoRoot, envFile, managedKeys, baseFlags, ["up", "-d", "--build"]);
	await waitForGateway(values.GATEWAY_PORT || "8000");

	console.log("\nCreate the first administrator. The password is prompted for here —");
	console.log("it never lands in shell history or in any file.");
	await runCompose(pystinoRoot, envFile, managedKeys, baseFlags, [
		"exec",
		"gateway",
		"gateway",
		"passwd",
		"admin@local",
	]);

	console.log("\nCreating the chat's Postgres role and database ...");
	const sql = `DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'chat') THEN
    CREATE ROLE chat WITH LOGIN PASSWORD '${values.CHAT_PG_PASSWORD.replace(/'/g, "''")}';
  ELSE
    ALTER ROLE chat WITH LOGIN PASSWORD '${values.CHAT_PG_PASSWORD.replace(/'/g, "''")}';
  END IF;
END $$;
SELECT 'role ok';
CREATE DATABASE chat OWNER chat;
GRANT ALL PRIVILEGES ON DATABASE chat TO chat;
`;
	try {
		await runCompose(
			pystinoRoot,
			envFile,
			managedKeys,
			baseFlags,
			["exec", "-T", "postgres", "psql", "-U", "gateway", "-d", "gateway", "-v", "ON_ERROR_STOP=1"],
			{ input: sql }
		);
	} catch (err) {
		/* CREATE DATABASE fails if it exists; the role block above is
		 * idempotent, so a failure here on resume means "already there". */
		note(
			`chat database step reported: ${err.message} — continuing if the database already exists.`
		);
		const check = await new Promise((resolve) => {
			const child = spawn(
				"docker",
				composeArgs(pystinoRoot, envFile, baseFlags, [
					"exec",
					"-T",
					"postgres",
					"psql",
					"-U",
					"gateway",
					"-d",
					"gateway",
					"-tAc",
					"SELECT 1 FROM pg_database WHERE datname='chat'",
				]),
				{
					cwd: pystinoRoot,
					env: cleanEnv(managedKeys),
					stdio: ["ignore", "pipe", "ignore"],
				}
			);
			let out = "";
			child.stdout.on("data", (c) => (out += c));
			child.on("close", () => resolve(out.trim()));
		});
		if (check !== "1")
			fail(
				"the chat database does not exist and creating it failed. Create it by hand, then re-run with --phase2."
			);
		note("Chat database already present — continuing.");
	}

	const port = values.GATEWAY_PORT || "8000";
	console.log(
		`\nPhase 1 is up. Open ${paint(`http://localhost:${port}/console`, "cyan")} and create an API key`
	);
	console.log("for the chat catalogue (a key whose user sees every model), then paste it here.");
	console.log("Listing models bills nothing, so the key spends nothing.");
	let catalogue = "";
	for (;;) {
		catalogue = await askHidden(io, "Catalogue gwk_ key");
		if (catalogue === "") {
			console.log(paint("The chat cannot build its model list without this key.", "yellow"));
			continue;
		}
		if (!catalogue.startsWith("gwk_")) {
			warn("That does not look like a gateway key (expected gwk_ prefix).");
			if (!(await confirm(io, "Use it anyway?", false))) continue;
		}
		break;
	}
	values.CHAT_CATALOGUE_KEY = catalogue;
}

async function phaseTwo(pystinoRoot, envFile, managedKeys, overlayMode, overlayArgs, values) {
	title("Phase 2 — full stack");
	const flags = overlayFlags(pystinoRoot, managedKeys, overlayMode, ...overlayArgs);
	console.log(`Overlay set: ${flags.filter((f) => f !== "-f").join(" ")}`);
	console.log(
		"Building images (first run downloads; the browser image is 3.45 GB) and starting ..."
	);
	await runCompose(pystinoRoot, envFile, managedKeys, flags, ["up", "-d", "--build"]);
	console.log(`\n${paint("Up.", "green")} Next steps:`);
	console.log(`  - Chat:      ${values.PUBLIC_ORIGIN}/chat`);
	console.log(
		`  - Console:   ${values.PUBLIC_ORIGIN}/console (or http://localhost:${values.GATEWAY_PORT || "8000"}/console over SSH)`
	);
	console.log(
		"  - Providers: add real models in the console — no profile ships a provider, so nothing answers until then."
	);
	if (values.GATEWAY_ACCOUNTING__ENABLED === "true") {
		console.log(
			"  - Quotas: define quota rules in the console; the demo cap pattern is EUR 1/hour."
		);
	} else {
		console.log(
			"  - Ledger: off (passthrough shape). Turning it on later records from that moment — history before it is a gap, not a bug."
		);
	}
	console.log(
		`\n${paint("Back up GATEWAY_SECRET_KEY with the database now,", "yellow")} not when you need it.`
	);
}

async function main() {
	const argv = process.argv.slice(2);
	const cliPystino = argv[argv.indexOf("--pystino") + 1] ?? null;
	const phase2Only = argv.includes("--phase2");
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log("Usage: node installer/install.mjs [--pystino <path>] [--phase2]");
		console.log(
			"  --phase2   resume against an existing deploy/.env (catalogue key prompt + full bring-up)"
		);
		process.exit(0);
	}

	console.log(paint("\nCerea + Pystino installer", "bold"));
	console.log("Chat interface plus self-hosted OpenAI-compatible gateway, on one box.");
	checkDocker();
	const io = makeInput();

	const pystinoRoot = await ensurePystinoRoot(io, cliPystino);
	const chatRepo = await ensureChatRepo(io);
	const envFile = path.join(pystinoRoot, "deploy", ".env");

	let profileKey;
	let state;
	let exposure;
	let existing = null;
	if (phase2Only) {
		if (!fs.existsSync(envFile))
			fail(`--phase2 needs ${envFile} to exist. Run the full installer first.`);
		existing = parseEnvFile(envFile).values;
		note(`Resuming with ${envFile} — existing secrets are kept, none regenerated.`);
		profileKey = await ask(
			io,
			"Profile this .env was built from (homelab|team|enterprise)",
			"homelab"
		);
		if (!PROFILES[profileKey]) fail(`unknown profile '${profileKey}'.`);
		exposure = (await ask(io, "Exposure (edge|proxy)", "edge")).trim();
		if (!["edge", "proxy"].includes(exposure)) fail("exposure must be edge or proxy.");
		const eng = existing.get("GATEWAY_REDACTION__ENGINE") || "noop";
		state = {
			redaction:
				eng === "http"
					? (existing.get("SPACY_MODELS") ?? "").trim() === ""
						? "pattern"
						: "ner"
					: "off",
			fetch: existing.get("FETCH_BACKEND") || "direct",
			metering: existing.get("GATEWAY_ACCOUNTING__ENABLED") !== "false",
			codeTool: existing.get("CHAT_CODE_TOOL_ENABLED") === "true",
			usage: (existing.get("CHAT_USAGE_ENABLED") ?? "") !== "",
			knowledge: existing.get("CHAT_KNOWLEDGE_ENABLED") !== "false",
		};
		note(
			`Inferred toggles: redaction=${state.redaction} fetch=${state.fetch} metering=${state.metering}. Re-run the full flow to change them.`
		);
	} else {
		profileKey = await chooseProfile(io);
		state = await toggleComponents(io, profileKey);
		exposure = await chooseExposure(io);
	}
	const profile = PROFILES[profileKey];

	/* Secrets + values. Fresh installs generate; resume keeps. */
	const values = phase2Only
		? Object.fromEntries(existing.entries())
		: await collectValues(io, profileKey, state, exposure, null);
	values.CHAT_REPO = chatRepo;
	if (!phase2Only) {
		const overlayMode = "custom_overlays";
		const overlayArgs = [exposure, state.redaction, state.fetch];
		/* The catalogue key arrives in phase 1 (it is minted against the
		 * running gateway), so it is excluded from the pre-write check and
		 * validated with everything else before phase 2. */
		validateFinal(
			requiredKeysFor(profileKey, state, exposure).filter((k) => k !== "CHAT_CATALOGUE_KEY"),
			values
		);

		/* Review: keys with provenance, values masked. */
		title("Review");
		const secretKeys = new Set(SECRET_SPECS.map((s) => s.key));
		for (const [key, value] of Object.entries(values)) {
			let shown;
			if (key === "CHAT_PG_URL") {
				/* The URL embeds the generated password — mask it like any
				 * other secret rather than leaking it beside the masked
				 * CHAT_PG_PASSWORD row above. */
				shown = value.replace(/:\/\/[^:]+:[^@]+@/, "://chat:(hidden)@");
			} else if (secretKeys.has(key)) shown = "(generated secret, hidden)";
			else shown = value === "" ? "(empty)" : value;
			console.log(`  ${key}=${shown}`);
		}
		if (
			await confirm(
				io,
				"Show generated secret values once (they live in deploy/.env afterwards)?",
				false
			)
		) {
			for (const spec of SECRET_SPECS) {
				if (values[spec.key] !== undefined && !spec.internal)
					console.log(`  ${spec.key}=${values[spec.key]}`);
			}
			console.log(`  CHAT_PG_URL=${values.CHAT_PG_URL}`);
		}
		const show = await confirm(io, `Write ${envFile}?`, true);
		if (!show) fail("not written. Re-run when ready — nothing was changed.");
		if (fs.existsSync(envFile)) {
			const backup = `${envFile}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
			fs.copyFileSync(envFile, backup);
			note(`Existing file backed up to ${backup}.`);
		}
		const fragmentPath = path.join(pystinoRoot, "deploy", "profiles", profile.fragment);
		const content = buildEnvLines(fragmentPath, values, {});
		fs.writeFileSync(envFile, content.endsWith("\n") ? content : content + "\n", { mode: 0o600 });
		console.log(`Wrote ${envFile} (mode 600).`);

		const managedKeys = new Set([...Object.keys(values), "GATEWAY_PORT"]);
		await phaseOne(io, pystinoRoot, envFile, managedKeys, values);
		/* The catalogue key arrived in phase 1 — persist it, then validate
		 * the complete file before phase 2. */
		validateFinal(requiredKeysFor(profileKey, state, exposure), values);
		const rewritten = buildEnvLines(fragmentPath, values, {});
		fs.writeFileSync(envFile, rewritten.endsWith("\n") ? rewritten : rewritten + "\n", {
			mode: 0o600,
		});
		await phaseTwo(pystinoRoot, envFile, managedKeys, overlayMode, overlayArgs, values);
	} else {
		const managedKeys = new Set([...Object.keys(values), "GATEWAY_PORT"]);
		if ((values.CHAT_CATALOGUE_KEY ?? "") === "") {
			console.log("\nNo catalogue key in the file yet — create one in the console and paste it.");
			values.CHAT_CATALOGUE_KEY = await askHidden(io, "Catalogue gwk_ key");
			const fragmentPath = path.join(pystinoRoot, "deploy", "profiles", profile.fragment);
			const rewritten = buildEnvLines(fragmentPath, values, {});
			fs.writeFileSync(envFile, rewritten.endsWith("\n") ? rewritten : rewritten + "\n", {
				mode: 0o600,
			});
			console.log(`Updated ${envFile}.`);
		}
		validateFinal(requiredKeysFor(profileKey, state, exposure), values);
		await phaseTwo(
			pystinoRoot,
			envFile,
			managedKeys,
			"custom_overlays",
			[exposure, state.redaction, state.fetch],
			values
		);
	}
	inputFinished = true;
	io.close();
}

/* Running directly starts the installer; importing exposes the pure helpers
 * for tests without side effects. */
if (
	process.argv[1] !== undefined &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch((err) => {
		fail(err.message ?? String(err));
	});
}

export { buildEnvLines, parseEnvFile, tokenUrlSafe, requiredKeysFor, PROFILES, FOOTPRINTS };
