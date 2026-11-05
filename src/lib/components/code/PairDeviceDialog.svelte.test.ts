import { describe, it, expect, vi } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import PairDeviceDialog from "./PairDeviceDialog.svelte";
import { OPENCODE_VERSION, buildEnrollCommand } from "$lib/codeEnrollCommand";
import { ENROLL_FLAGS } from "$lib/enrollFlags";
import { FLAG_CONTROLS, exposedFlags } from "$lib/codeEnrollPolicy";

/**
 * The enrollment dialog prints the command a person runs on their machine,
 * and offers every enroll flag that sets machine policy so nobody edits the
 * printed command by hand. Pinned here: every exposed flag has a control; the
 * untouched dialog prints exactly the defaults — `enroll`'s own, plus the one
 * deliberate divergence, Bill to my default group ticked; each control emits
 * exactly its flag; `--limit` is printed only for a class that was changed;
 * Advanced is collapsed by default yet never hides a choice from the preview;
 * and no word of auto-accept survives.
 */
vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	listDevices: async () => ({ devices: [] }),
}));

const ISSUER = "https://issuer.example/realms/r";
const GATEWAY = "https://gw.example";
const ORIGIN = "https://chat.example";

function mount(data: Record<string, unknown> = {}) {
	return renderWithApp(
		PairDeviceDialog,
		{ onclose: () => {}, onpaired: () => {} },
		{
			page: { data: { codeOidcIssuerUrl: ISSUER, codeGatewayOrigin: GATEWAY, ...data } },
			publicConfig: { PUBLIC_ORIGIN: ORIGIN },
		}
	);
}

type Screen = ReturnType<typeof mount>;

function command(screen: Screen): string {
	return screen.getByTestId("galopin-enroll-command").element().textContent?.trim() ?? "";
}

/** The command an untouched dialog prints: the plain enroll one plus
 * `--default-group`, the one policy flag the dialog ticks by default. */
const PLAIN = buildEnrollCommand({ origin: ORIGIN, issuer: ISSUER, gatewayOrigin: GATEWAY });
/** The command with no policy flag at all: what the dialog prints with the
 * billing box unticked — the one control whose default is not enroll's own. */
const BARE = buildEnrollCommand({
	origin: ORIGIN,
	issuer: ISSUER,
	gatewayOrigin: GATEWAY,
	billToDefault: false,
});

/** Advanced's own toggle (other text mentions "Advanced" too). */
function toggleAdvanced(screen: Screen) {
	(screen.getByTestId("enroll-advanced").element().querySelector("summary") as HTMLElement).click();
}

async function openAdvanced(screen: Screen) {
	const details = screen.getByTestId("enroll-advanced");
	if (!(details.element() as HTMLDetailsElement).open) {
		toggleAdvanced(screen);
	}
	await expect.element(screen.getByTestId("enroll-no-files")).toBeVisible();
}

/** The part of the command after `--cerea '<origin>'`, up to the run step,
 * read as one line (the command prints one flag per line). */
function policyPart(screen: Screen): string {
	const text = command(screen)
		.replace(/ \\\n\s*/g, " ")
		.replace(/ &&\n/g, " && ");
	const after = text.split(`--cerea '${ORIGIN}'`)[1] ?? "";
	return after.split(" && ")[0].trim();
}

describe("PairDeviceDialog", () => {
	it("opens with every default, and prints exactly the defaults: --default-group, nothing else", async () => {
		await browserPage.viewport(1200, 1000);
		const screen = mount();
		await expect.element(screen.getByText("Pair a machine")).toBeVisible();
		expect(command(screen)).toBe(PLAIN);
		expect(policyPart(screen)).toBe("--default-group");
		await openAdvanced(screen);
		await expect.element(screen.getByTestId("enroll-bill-to-default")).toBeChecked();
	});

	it("says once, plainly, that these are fixed at enroll", async () => {
		const screen = mount();
		const note = screen.getByTestId("enroll-fixed-note");
		await expect.element(note).toBeVisible();
		const text = note.element().textContent?.replace(/\s+/g, " ").trim();
		expect(text).toBe(
			"These are fixed when the machine enrolls. Loosening one later means enrolling again; galopin policy set on the machine can only tighten."
		);
		expect(screen.getByTestId("enroll-fixed-note").elements()).toHaveLength(1);
	});

	it("mentions no auto-accept, no responder, anywhere", async () => {
		const screen = mount();
		await openAdvanced(screen);
		const text = screen.container.textContent ?? "";
		expect(text).not.toMatch(/auto-accept|auto accept|responder/i);
		expect(screen.getByRole("checkbox", { name: /auto-accept/i }).elements()).toHaveLength(0);
	});

	it("keeps the plain-words sentences for the two it had: Trust the repos, Install opencode", async () => {
		const screen = mount();
		await expect
			.element(screen.getByRole("checkbox", { name: /Trust the repos this machine opens/ }))
			.toBeVisible();
		await expect.element(screen.getByRole("checkbox", { name: /Install opencode/ })).toBeVisible();
		expect(screen.getByTestId("enroll-allow-project-config").element()).not.toBeChecked();
	});
});

describe("every exposed flag has a control", () => {
	it("the control table is exactly the exposed flags, and each control is on the screen", async () => {
		expect(Object.keys(FLAG_CONTROLS).sort()).toEqual(exposedFlags().sort());
		const screen = mount();
		await openAdvanced(screen);
		// Terminals are on by default, so their cap is on the screen too.
		for (const testid of Object.values(FLAG_CONTROLS)) {
			await expect.element(screen.getByTestId(testid)).toBeInTheDocument();
		}
	});

	it("none of the connection plumbing has one", async () => {
		const screen = mount();
		await openAdvanced(screen);
		const text = screen.container.textContent ?? "";
		for (const flag of ENROLL_FLAGS.filter((f) => !f.exposed)) {
			expect(text, flag.flag).not.toContain(`--${flag.flag}`);
		}
	});
});

describe("each control emits exactly its flag", () => {
	const checkboxes: Array<[string, string, string, boolean]> = [
		// testid, flag, label, needs Advanced open. Terminals, the command shell and
		// background subagents are on by default: clicking turns them off. The
		// billing box is not here: it is ticked by default, so clicking REMOVES
		// its flag, and it has its own test below.
		["enroll-allow-terminal", "--no-terminal", "terminals off", true],
		["enroll-allow-project-config", "--allow-project-config", "trust repos", false],
		["enroll-allow-command-shell", "--no-command-shell", "command shell off", true],
		["enroll-allow-background-subagents", "--no-background-subagents", "background off", true],
		["enroll-no-agent-tools", "--no-agent-tools", "no agent tools", true],
		["enroll-allow-free-models", "--allow-free-models", "free models", true],
		["enroll-allow-opencode-provider", "--allow-opencode-provider", "opencode provider", true],
		["enroll-no-files", "--no-files", "no files", true],
		["enroll-allow-file-write", "--allow-file-write", "saving files", true],
		["enroll-no-default-file-deny", "--no-default-file-deny", "no default deny", true],
	];
	for (const [testid, flag, label, advanced] of checkboxes) {
		it(`${label}: clicking adds ${flag} and nothing else, clicking again removes it`, async () => {
			const screen = mount();
			if (advanced) await openAdvanced(screen);
			await screen.getByTestId(testid).click();
			// --default-group was already there: the billing box is ticked
			// before the click, and stays ticked.
			expect(policyPart(screen)).toBe(`--default-group ${flag}`);
			await screen.getByTestId(testid).click();
			expect(command(screen)).toBe(PLAIN);
		});
	}

	it("bill to my default group: ticked by default; unticking removes --default-group alone, ticking again restores it", async () => {
		const screen = mount();
		await openAdvanced(screen);
		await expect.element(screen.getByTestId("enroll-bill-to-default")).toBeChecked();
		expect(policyPart(screen)).toBe("--default-group");
		await screen.getByTestId("enroll-bill-to-default").click();
		expect(policyPart(screen)).toBe("");
		expect(command(screen)).toBe(BARE);
		await screen.getByTestId("enroll-bill-to-default").click();
		expect(policyPart(screen)).toBe("--default-group");
		expect(command(screen)).toBe(PLAIN);
	});

	it("Install opencode adds the install line, and is not a policy flag", async () => {
		const screen = mount();
		await screen.getByTestId("enroll-install-opencode").click();
		expect(command(screen)).toContain(
			` &&\ncurl -fsSL https://opencode.ai/install | bash -s -- --version ${OPENCODE_VERSION} &&\n`
		);
		expect(policyPart(screen)).toBe("--default-group");
	});

	it("max terminals: shown while terminals are on, emitted when not 8", async () => {
		const screen = mount();
		await openAdvanced(screen);
		const number = screen.getByTestId("enroll-max-terminals");
		await expect.element(number).toHaveValue(8);
		expect(policyPart(screen)).toBe("--default-group");
		await number.fill("3");
		expect(policyPart(screen)).toBe("--default-group --max-terminals 3");
		await number.fill("8");
		expect(policyPart(screen)).toBe("--default-group");
		// An unusable number says so, and the command keeps the default rather
		// than print a flag enroll would refuse.
		await number.fill("0");
		await expect.element(screen.getByTestId("enroll-max-terminals-problem")).toBeVisible();
		expect(policyPart(screen)).toBe("--default-group");
		// Turning terminals off hides the cap and forgets it in the command.
		await number.fill("3");
		await screen.getByTestId("enroll-allow-terminal").click();
		expect(screen.getByTestId("enroll-max-terminals").elements()).toHaveLength(0);
		expect(policyPart(screen)).toBe("--default-group --no-terminal");
	});

	it("workspace roots: a repeatable list, one flag per entry, blank rows ignored", async () => {
		const screen = mount();
		await openAdvanced(screen);
		const list = screen.getByTestId("enroll-workspace-roots");
		await list.getByRole("button", { name: "Add" }).click();
		await list.getByRole("button", { name: "Add" }).click();
		await list.getByRole("textbox", { name: "Workspace folders. 1" }).fill("/srv/a");
		expect(policyPart(screen)).toBe("--default-group --workspace-root '/srv/a'");
		await list.getByRole("textbox", { name: "Workspace folders. 2" }).fill("/srv/b");
		expect(policyPart(screen)).toBe(
			"--default-group --workspace-root '/srv/a' --workspace-root '/srv/b'"
		);
		await list.getByRole("button", { name: "Remove workspace folders. 1" }).click();
		expect(policyPart(screen)).toBe("--default-group --workspace-root '/srv/b'");
	});

	it("file deny: a repeatable glob list", async () => {
		const screen = mount();
		await openAdvanced(screen);
		const list = screen.getByTestId("enroll-file-deny");
		await list.getByRole("button", { name: "Add" }).click();
		await list.getByRole("textbox", { name: "Hide files. 1" }).fill("*.secret");
		expect(policyPart(screen)).toBe("--default-group --file-deny '*.secret'");
	});

	it("the old fixed-answer checkboxes and the dead secrets control are gone", async () => {
		const screen = mount();
		await openAdvanced(screen);
		for (const gone of [
			"enroll-fixed-answers",
			"enroll-allow-outside-project",
			"enroll-allow-secret-reads",
			"enroll-ceiling",
		]) {
			expect(screen.getByTestId(gone).elements(), gone).toHaveLength(0);
		}
		await expect
			.element(screen.getByText("Agents may read secret files without asking."))
			.not.toBeInTheDocument();
		expect(command(screen)).toBe(PLAIN);
	});
});

describe("the limits (ADR 0107)", () => {
	const row = (screen: Screen, cls: string) => screen.getByTestId(`enroll-limit-${cls}`);
	const pick = (screen: Screen, cls: string, word: string) =>
		row(screen, cls).getByRole("button", { name: word }).click();
	const pressed = (screen: Screen, cls: string) =>
		row(screen, cls).element().querySelector('[aria-pressed="true"]')?.textContent?.trim() ?? null;

	it("commands sit in the common part, defaulting to Ask, and print nothing", async () => {
		const screen = mount();
		await expect.element(row(screen, "command")).toBeVisible();
		expect(pressed(screen, "command")).toBe("Ask");
		expect(policyPart(screen)).toBe("--default-group");
		await expect.element(screen.getByTestId("enroll-limits-note")).toHaveTextContent("Default");
	});

	it("shows the class table under Advanced with the machine's defaults, and secrets without Run, loops with Stop", async () => {
		const screen = mount();
		await openAdvanced(screen);
		const expected: Record<string, string> = {
			edit: "Run",
			web: "Run",
			outside: "Ask",
			secrets: "Ask",
			agents: "Run",
			tools: "Run",
			loop: "Ask",
		};
		for (const [cls, word] of Object.entries(expected))
			expect(pressed(screen, cls), cls).toBe(word);
		const words = (cls: string) =>
			[...row(screen, cls).element().querySelectorAll("button")].map((b) => b.textContent?.trim());
		expect(words("secrets")).toEqual(["Never", "Ask"]);
		expect(words("loop")).toEqual(["Ask", "Stop the turn"]);
		expect(words("edit")).toEqual(["Never", "Ask", "Run"]);
		expect(policyPart(screen)).toBe("--default-group");
	});

	it("one changed class prints one --limit, and moving it back prints nothing again", async () => {
		const screen = mount();
		await openAdvanced(screen);
		await pick(screen, "edit", "Ask");
		expect(policyPart(screen)).toBe("--default-group --limit edit=ask");
		await expect.element(screen.getByTestId("enroll-limits-note")).toHaveTextContent("Changed");
		await pick(screen, "edit", "Run");
		expect(policyPart(screen)).toBe("--default-group");
	});

	it("opening commands prints command=run and warns in the amber tone", async () => {
		const screen = mount();
		expect(screen.getByTestId("enroll-command-run-warning").elements()).toHaveLength(0);
		await pick(screen, "command", "Run");
		expect(policyPart(screen)).toBe("--default-group --limit command=run");
		await expect.element(screen.getByTestId("enroll-command-run-warning")).toBeVisible();
	});

	it("never, outside and loop stop are carried as typed, and never the old alias flags", async () => {
		const screen = mount();
		await openAdvanced(screen);
		await pick(screen, "web", "Never");
		await pick(screen, "outside", "Run");
		await pick(screen, "loop", "Stop the turn");
		expect(policyPart(screen)).toBe(
			"--default-group --limit web=never --limit outside=run --limit loop=stop"
		);
		expect(command(screen)).not.toContain("permission-");
	});

	it("only the classes changed reach the Advanced count, commands excluded", async () => {
		const screen = mount();
		await pick(screen, "command", "Run");
		expect(screen.getByTestId("enroll-advanced-count").elements()).toHaveLength(0);
		await openAdvanced(screen);
		await pick(screen, "web", "Never");
		await expect.element(screen.getByTestId("enroll-advanced-count")).toHaveTextContent("1");
	});
});

describe("Advanced", () => {
	it("is collapsed by default, with no count while everything is default", async () => {
		const screen = mount();
		expect((screen.getByTestId("enroll-advanced").element() as HTMLDetailsElement).open).toBe(
			false
		);
		expect(screen.getByTestId("enroll-advanced-count").elements()).toHaveLength(0);
	});

	it("keeps a non-default value in the preview after it is collapsed again, and counts it", async () => {
		const screen = mount();
		await openAdvanced(screen);
		await screen.getByTestId("enroll-allow-command-shell").click();
		await screen.getByTestId("enroll-no-files").click();
		// Collapse it.
		toggleAdvanced(screen);
		expect((screen.getByTestId("enroll-advanced").element() as HTMLDetailsElement).open).toBe(
			false
		);
		expect(policyPart(screen)).toBe("--default-group --no-command-shell --no-files");
		await expect
			.element(screen.getByTestId("enroll-advanced-count"))
			.toHaveTextContent("2 changed");
	});

	it("shows a list value typed under Advanced in the preview while collapsed", async () => {
		const screen = mount();
		await openAdvanced(screen);
		const list = screen.getByTestId("enroll-workspace-roots");
		await list.getByRole("button", { name: "Add" }).click();
		await list.getByRole("textbox", { name: "Workspace folders. 1" }).fill("/srv/a");
		toggleAdvanced(screen);
		expect(policyPart(screen)).toBe("--default-group --workspace-root '/srv/a'");
	});
});

describe("quoting in the preview", () => {
	it("a path with spaces is one argument", async () => {
		const screen = mount();
		await openAdvanced(screen);
		const list = screen.getByTestId("enroll-workspace-roots");
		await list.getByRole("button", { name: "Add" }).click();
		await list.getByRole("textbox", { name: "Workspace folders. 1" }).fill("/home/me/my projects");
		expect(policyPart(screen)).toBe("--default-group --workspace-root '/home/me/my projects'");
	});

	it("a glob with * is quoted so the shell leaves it alone", async () => {
		const screen = mount();
		await openAdvanced(screen);
		const list = screen.getByTestId("enroll-file-deny");
		await list.getByRole("button", { name: "Add" }).click();
		await list.getByRole("textbox", { name: "Hide files. 1" }).fill("config/*.pem");
		expect(policyPart(screen)).toBe("--default-group --file-deny 'config/*.pem'");
	});
});

describe("the risky ones read as risky", () => {
	it("terminal, trusting repos, the command shell, dropping the secret list and saving files carry the warning tone", async () => {
		const screen = mount();
		await openAdvanced(screen);
		for (const testid of [
			"enroll-allow-terminal",
			"enroll-allow-project-config",
			"enroll-allow-command-shell",
			"enroll-no-default-file-deny",
			"enroll-allow-file-write",
		]) {
			const label = screen.getByTestId(testid).element().closest("label");
			expect(label?.querySelector('[data-risky="true"]'), testid).not.toBeNull();
		}
		for (const testid of [
			"enroll-allow-background-subagents",
			"enroll-no-agent-tools",
			"enroll-allow-free-models",
			"enroll-no-files",
			"enroll-install-opencode",
		]) {
			const label = screen.getByTestId(testid).element().closest("label");
			expect(label?.querySelector('[data-risky="true"]'), testid).toBeNull();
		}
	});
});

describe("the deployment's terminal switch", () => {
	it("says the terminal is off for this deployment when it is", async () => {
		const screen = mount({ codeTerminalEnabled: false });
		await openAdvanced(screen);
		await expect
			.element(screen.getByTestId("enroll-terminal-deployment-off"))
			.toHaveTextContent("Terminal is off for this deployment");
	});

	it("says nothing extra when the deployment offers terminals", async () => {
		const screen = mount({ codeTerminalEnabled: true });
		await openAdvanced(screen);
		await expect.element(screen.getByTestId("enroll-allow-terminal")).toBeInTheDocument();
		expect(
			screen.container.querySelector("[data-testid='enroll-terminal-deployment-off']")
		).toBeNull();
	});
});
