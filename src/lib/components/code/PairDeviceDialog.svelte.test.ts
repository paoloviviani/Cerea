import { describe, it, expect, vi } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import PairDeviceDialog from "./PairDeviceDialog.svelte";
import { buildEnrollCommand } from "$lib/codeEnrollCommand";
import { ENROLL_FLAGS } from "$lib/enrollFlags";
import { FLAG_CONTROLS, exposedFlags } from "$lib/codeEnrollPolicy";

/**
 * The enrollment dialog prints the command a person runs on their machine,
 * and offers every enroll flag that sets machine policy so nobody edits the
 * printed command by hand. Pinned here: every exposed flag has a control; a
 * default emits nothing; each control emits exactly its flag; the ceiling
 * table writes the whole set once a row changes; Advanced is collapsed by
 * default yet never hides a choice from the preview; and no word of
 * auto-accept survives.
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

function mount() {
	return renderWithApp(
		PairDeviceDialog,
		{ onclose: () => {}, onpaired: () => {} },
		{
			page: { data: { codeOidcIssuerUrl: ISSUER, codeGatewayOrigin: GATEWAY } },
			publicConfig: { PUBLIC_ORIGIN: ORIGIN },
		}
	);
}

type Screen = ReturnType<typeof mount>;

function command(screen: Screen): string {
	return screen.getByTestId("galopin-enroll-command").element().textContent?.trim() ?? "";
}

/** The command with no policy flag at all: what an untouched dialog prints. */
const PLAIN = buildEnrollCommand({ origin: ORIGIN, issuer: ISSUER, gatewayOrigin: GATEWAY });

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
	it("opens with every default, and prints exactly the plain command", async () => {
		await browserPage.viewport(1200, 1000);
		const screen = mount();
		await expect.element(screen.getByText("Pair a machine")).toBeVisible();
		expect(command(screen)).toBe(PLAIN);
		expect(policyPart(screen)).toBe("");
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
		// background subagents are on by default: clicking turns them off.
		["enroll-allow-terminal", "--no-terminal", "terminals off", true],
		["enroll-allow-project-config", "--allow-project-config", "trust repos", false],
		["enroll-allow-command-shell", "--no-command-shell", "command shell off", true],
		["enroll-allow-background-subagents", "--no-background-subagents", "background off", true],
		["enroll-no-agent-tools", "--no-agent-tools", "no agent tools", true],
		["enroll-allow-free-models", "--allow-free-models", "free models", true],
		["enroll-allow-opencode-provider", "--allow-opencode-provider", "opencode provider", true],
		["enroll-no-files", "--no-files", "no files", true],
		["enroll-no-default-file-deny", "--no-default-file-deny", "no default deny", true],
	];
	for (const [testid, flag, label, advanced] of checkboxes) {
		it(`${label}: clicking adds ${flag} and nothing else, clicking again removes it`, async () => {
			const screen = mount();
			if (advanced) await openAdvanced(screen);
			await screen.getByTestId(testid).click();
			expect(policyPart(screen)).toBe(flag);
			await screen.getByTestId(testid).click();
			expect(command(screen)).toBe(PLAIN);
		});
	}

	it("Install opencode adds the install line, and is not a policy flag", async () => {
		const screen = mount();
		await screen.getByTestId("enroll-install-opencode").click();
		expect(command(screen)).toContain(" &&\ncurl -fsSL https://opencode.ai/install | bash &&\n");
		expect(policyPart(screen)).toBe("");
	});

	it("max terminals: shown while terminals are on, emitted when not 8", async () => {
		const screen = mount();
		await openAdvanced(screen);
		const number = screen.getByTestId("enroll-max-terminals");
		await expect.element(number).toHaveValue(8);
		expect(policyPart(screen)).toBe("");
		await number.fill("3");
		expect(policyPart(screen)).toBe("--max-terminals 3");
		await number.fill("8");
		expect(policyPart(screen)).toBe("");
		// An unusable number says so, and the command keeps the default rather
		// than print a flag enroll would refuse.
		await number.fill("0");
		await expect.element(screen.getByTestId("enroll-max-terminals-problem")).toBeVisible();
		expect(policyPart(screen)).toBe("");
		// Turning terminals off hides the cap and forgets it in the command.
		await number.fill("3");
		await screen.getByTestId("enroll-allow-terminal").click();
		expect(screen.getByTestId("enroll-max-terminals").elements()).toHaveLength(0);
		expect(policyPart(screen)).toBe("--no-terminal");
	});

	it("workspace roots: a repeatable list, one flag per entry, blank rows ignored", async () => {
		const screen = mount();
		await openAdvanced(screen);
		const list = screen.getByTestId("enroll-workspace-roots");
		await list.getByRole("button", { name: "Add" }).click();
		await list.getByRole("button", { name: "Add" }).click();
		await list.getByRole("textbox", { name: "Workspace folders. 1" }).fill("/srv/a");
		expect(policyPart(screen)).toBe("--workspace-root '/srv/a'");
		await list.getByRole("textbox", { name: "Workspace folders. 2" }).fill("/srv/b");
		expect(policyPart(screen)).toBe("--workspace-root '/srv/a' --workspace-root '/srv/b'");
		await list.getByRole("button", { name: "Remove workspace folders. 1" }).click();
		expect(policyPart(screen)).toBe("--workspace-root '/srv/b'");
	});

	it("file deny: a repeatable glob list", async () => {
		const screen = mount();
		await openAdvanced(screen);
		const list = screen.getByTestId("enroll-file-deny");
		await list.getByRole("button", { name: "Add" }).click();
		await list.getByRole("textbox", { name: "Hide files. 1" }).fill("*.secret");
		expect(policyPart(screen)).toBe("--file-deny '*.secret'");
	});

	it("machine rules: a repeatable key and answer list, said plainly", async () => {
		const screen = mount();
		await openAdvanced(screen);
		const rules = screen.getByTestId("enroll-permission-rules");
		await expect.element(rules).toHaveTextContent("A Deny always holds");
		await expect.element(rules).toHaveTextContent("external_directory on Allow");
		await rules.getByRole("button", { name: "Add rule" }).click();
		await rules.getByRole("combobox", { name: "Permission for rule 1" }).fill("webfetch");
		await rules
			.getByRole("group", { name: "Answer for rule 1" })
			.getByRole("button", { name: "Deny" })
			.click();
		expect(policyPart(screen)).toBe("--permission-rule 'webfetch=deny'");
		await rules.getByRole("button", { name: "Remove rule 1" }).click();
		expect(command(screen)).toBe(PLAIN);
	});

	it("machine rules: a pattern as the key is flagged, since enroll would refuse it", async () => {
		const screen = mount();
		await openAdvanced(screen);
		const rules = screen.getByTestId("enroll-permission-rules");
		await rules.getByRole("button", { name: "Add rule" }).click();
		await rules.getByRole("combobox", { name: "Permission for rule 1" }).fill("ba*");
		await expect.element(screen.getByTestId("enroll-rule-problem")).toBeVisible();
	});
});

describe("the ceiling", () => {
	const row = (screen: Screen, key: string) => screen.getByTestId(`enroll-ceiling-${key}`);
	const pick = (screen: Screen, key: string, action: "Allow" | "Ask" | "Deny") =>
		row(screen, key).getByRole("button", { name: action }).click();
	const pressed = (screen: Screen, key: string) =>
		row(screen, key).element().querySelector('[aria-pressed="true"]')?.textContent?.trim() ?? null;

	it("All tools sits in the common part, and shows the default as mixed", async () => {
		const screen = mount();
		await expect.element(row(screen, "all")).toBeVisible();
		expect(pressed(screen, "all")).toBeNull();
		await expect.element(screen.getByTestId("enroll-ceiling-mixed")).toHaveTextContent("bash");
		expect(policyPart(screen)).toBe("");
	});

	it("has the six rows under Advanced, with enroll's defaults: bash and session_spawn ask", async () => {
		const screen = mount();
		await openAdvanced(screen);
		const keys = ["edit", "bash", "webfetch", "task", "session_spawn", "session_send"];
		const expected = ["Allow", "Ask", "Allow", "Allow", "Ask", "Allow"];
		for (const [i, key] of keys.entries()) expect(pressed(screen, key), key).toBe(expected[i]);
		expect(policyPart(screen)).toBe("");
	});

	it("All tools sets every row with one click, and prints the whole set", async () => {
		const screen = mount();
		await pick(screen, "all", "Ask");
		expect(pressed(screen, "all")).toBe("Ask");
		expect(policyPart(screen)).toBe(
			"--permission-max edit=ask --permission-max bash=ask --permission-max webfetch=ask " +
				"--permission-max task=ask --permission-max session_spawn=ask --permission-max session_send=ask"
		);
		await pick(screen, "all", "Allow");
		expect(policyPart(screen)).toBe(
			"--permission-max bash=allow --permission-max session_spawn=allow"
		);
		await expect.element(screen.getByTestId("enroll-bash-allow-warning")).toBeVisible();
	});

	it("one changed row prints the full set, defaults included", async () => {
		const screen = mount();
		await openAdvanced(screen);
		await pick(screen, "edit", "Ask");
		expect(policyPart(screen)).toBe(
			"--permission-max edit=ask --permission-max bash=ask --permission-max session_spawn=ask"
		);
		await expect.element(screen.getByTestId("enroll-ceiling-edited")).toBeVisible();
		// Back to the default: nothing again.
		await pick(screen, "edit", "Allow");
		expect(policyPart(screen)).toBe("");
		expect(screen.getByTestId("enroll-ceiling-edited").elements()).toHaveLength(0);
	});

	it("opening bash names the opt-out explicitly, and warns", async () => {
		const screen = mount();
		await openAdvanced(screen);
		expect(screen.getByTestId("enroll-bash-allow-warning").elements()).toHaveLength(0);
		await pick(screen, "bash", "Allow");
		expect(policyPart(screen)).toBe(
			"--permission-max bash=allow --permission-max session_spawn=ask"
		);
		await expect.element(screen.getByTestId("enroll-bash-allow-warning")).toBeVisible();
	});

	it("a Deny row is carried as deny", async () => {
		const screen = mount();
		await openAdvanced(screen);
		await pick(screen, "webfetch", "Deny");
		expect(policyPart(screen)).toContain("--permission-max webfetch=deny");
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
		expect(policyPart(screen)).toBe("--no-command-shell --no-files");
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
		expect(policyPart(screen)).toBe("--workspace-root '/srv/a'");
	});
});

describe("quoting in the preview", () => {
	it("a path with spaces is one argument", async () => {
		const screen = mount();
		await openAdvanced(screen);
		const list = screen.getByTestId("enroll-workspace-roots");
		await list.getByRole("button", { name: "Add" }).click();
		await list.getByRole("textbox", { name: "Workspace folders. 1" }).fill("/home/me/my projects");
		expect(policyPart(screen)).toBe("--workspace-root '/home/me/my projects'");
	});

	it("a glob with * is quoted so the shell leaves it alone", async () => {
		const screen = mount();
		await openAdvanced(screen);
		const list = screen.getByTestId("enroll-file-deny");
		await list.getByRole("button", { name: "Add" }).click();
		await list.getByRole("textbox", { name: "Hide files. 1" }).fill("config/*.pem");
		expect(policyPart(screen)).toBe("--file-deny 'config/*.pem'");
	});
});

describe("the risky ones read as risky", () => {
	it("terminal, trusting repos, the command shell and dropping the secret list carry the warning tone", async () => {
		const screen = mount();
		await openAdvanced(screen);
		for (const testid of [
			"enroll-allow-terminal",
			"enroll-allow-project-config",
			"enroll-allow-command-shell",
			"enroll-no-default-file-deny",
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
