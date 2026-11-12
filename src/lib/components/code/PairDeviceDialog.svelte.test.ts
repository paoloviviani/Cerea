import { describe, it, expect, vi } from "vitest";
import { page as browserPage, userEvent } from "@vitest/browser/context";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import PairDeviceDialog from "./PairDeviceDialog.svelte";
import { buildDockerCommand, buildEnrollCommand, GALOPIN_IMAGE } from "$lib/codeEnrollCommand";
import { APP_VERSION } from "$lib/utils/appVersion";
import { ENROLL_FLAGS } from "$lib/enrollFlags";
import { FLAG_CONTROLS, exposedFlags } from "$lib/codeEnrollPolicy";

/**
 * The enrollment dialog prints the command a person runs on their machine,
 * and offers every enroll flag that sets machine policy so nobody edits the
 * printed command by hand. Pinned here: every exposed flag has a control; the
 * untouched dialog prints exactly the defaults — `enroll`'s own, plus the one
 * deliberate divergence, Bill to my default group ticked; each control emits
 * exactly its flag; there are no machine limits, so no `--limit` (ADR 0109);
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
		await expect.element(screen.getByText("Pair a computer")).toBeVisible();
		expect(command(screen)).toBe(PLAIN);
		expect(policyPart(screen)).toBe("--default-group");
		await openAdvanced(screen);
		await expect.element(screen.getByTestId("enroll-bill-to-default")).toBeChecked();
	});

	it("no longer says the options are fixed limits (ADR 0109)", async () => {
		const screen = mount();
		await expect.element(screen.getByTestId("enroll-policy")).toBeVisible();
		expect(screen.getByTestId("enroll-fixed-note").elements()).toHaveLength(0);
		expect(document.body.textContent).not.toContain("will ever allow");
	});

	it("mentions no auto-accept, no responder, anywhere", async () => {
		const screen = mount();
		await openAdvanced(screen);
		const text = screen.container.textContent ?? "";
		expect(text).not.toMatch(/auto-accept|auto accept|responder/i);
		expect(screen.getByRole("checkbox", { name: /auto-accept/i }).elements()).toHaveLength(0);
	});

	it("keeps the plain-words sentences for the two it had: the project's own setup, Install opencode", async () => {
		const screen = mount();
		await expect
			.element(screen.getByRole("checkbox", { name: /Use a project's own opencode setup/ }))
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

	it("Install opencode has the served installer fetch the pinned release, and is not a policy flag", async () => {
		const screen = mount();
		await screen.getByTestId("enroll-install-opencode").click();
		expect(command(screen)).toContain("install.sh' | sh -s -- --with-opencode &&\n");
		expect(policyPart(screen)).toBe("--default-group");
	});

	it("the engine: opencode by default and printing nothing; goose adds --engine goose and swaps the install line", async () => {
		const screen = mount();
		await openAdvanced(screen);
		const engine = screen.getByTestId("enroll-engine");
		await expect.element(engine).toHaveValue("opencode");
		expect(command(screen)).not.toContain("--engine");
		await engine.selectOptions("goose");
		expect(command(screen)).toContain("install.sh' | sh -s -- --engine goose &&");
		expect(policyPart(screen)).toBe("--engine goose --default-group");
		await engine.selectOptions("opencode");
		expect(command(screen)).toBe(PLAIN);
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

describe("no machine limits (ADR 0109)", () => {
	it("has no limits table, no commands pills and no limit warning, in the common part or under Advanced", async () => {
		const screen = mount();
		await openAdvanced(screen);
		for (const gone of [
			"enroll-limits",
			"enroll-limits-note",
			"enroll-limit-rows",
			"enroll-limit-command",
			"enroll-limit-edit",
			"enroll-command-run-warning",
		]) {
			expect(screen.getByTestId(gone).elements(), gone).toHaveLength(0);
		}
		expect(document.body.textContent).not.toMatch(
			/What this machine lets|Never refuses|Stop the turn/
		);
	});

	it("prints no --limit and no old alias flag, whatever is chosen", async () => {
		const screen = mount();
		await openAdvanced(screen);
		await screen.getByTestId("enroll-allow-command-shell").click();
		await screen.getByTestId("enroll-no-agent-tools").click();
		expect(command(screen)).not.toContain("--limit");
		expect(command(screen)).not.toContain("permission-");
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

/**
 * The Docker switch: "On this computer" (the default) or "In a Docker
 * container", which prints one `docker run` of this release's image. The
 * flags are the same either way; what only makes sense on a computer (the
 * download, installing opencode, the goose engine) is not offered in Docker.
 */
describe("the Docker switch", () => {
	const NATIVE = "On this computer";
	const DOCKER = "In a Docker container";

	function radio(screen: Screen, name: string) {
		return screen.getByRole("radio", { name });
	}
	async function chooseDocker(screen: Screen) {
		await radio(screen, DOCKER).click();
		await expect.element(radio(screen, DOCKER)).toBeChecked();
	}
	async function chooseNative(screen: Screen) {
		await radio(screen, NATIVE).click();
		await expect.element(radio(screen, NATIVE)).toBeChecked();
	}
	/** What an untouched dialog prints in Docker mode. */
	const dockerCommand = (extra: Record<string, unknown> = {}) =>
		buildDockerCommand({
			origin: ORIGIN,
			issuer: ISSUER,
			gatewayOrigin: GATEWAY,
			version: APP_VERSION,
			...extra,
		});

	it("opens on this computer, as a radio group of two, with the native command", async () => {
		const screen = mount();
		await expect
			.element(screen.getByRole("radiogroup", { name: "Where the agent runs" }))
			.toBeVisible();
		expect(screen.getByRole("radio").elements()).toHaveLength(2);
		await expect.element(radio(screen, NATIVE)).toBeChecked();
		await expect.element(radio(screen, DOCKER)).not.toBeChecked();
		expect(command(screen)).toBe(PLAIN);
		// Docker's own controls are not there until it is chosen.
		expect(screen.getByTestId("pair-docker-name").elements()).toHaveLength(0);
		expect(screen.getByTestId("pair-docker-keep").elements()).toHaveLength(0);
	});

	it("choosing Docker prints the docker run of this Cerea's image, with the dialog's own flags", async () => {
		const screen = mount();
		await chooseDocker(screen);
		const text = command(screen);
		expect(text).toBe(dockerCommand({ billToDefault: true }));
		expect(text.startsWith("docker run -it --rm")).toBe(true);
		expect(text).toContain(`${GALOPIN_IMAGE}:${APP_VERSION} `);
		expect(text).toContain("--hostname sandbox");
		expect(text).not.toContain("install.sh");
		expect(text).not.toContain("galopin run");
		expect(policyPart(screen)).toBe("--default-group");
		await expect
			.element(screen.getByTestId("pair-explain"))
			.toHaveTextContent("The container enrolls, then runs the agent");
		await expect.element(screen.getByText("Enroll and run in Docker")).toBeVisible();
	});

	it("the arrow keys move the choice, as in any radio group", async () => {
		const screen = mount();
		(radio(screen, NATIVE).element() as HTMLElement).focus();
		await userEvent.keyboard("{ArrowRight}");
		await expect.element(radio(screen, DOCKER)).toBeChecked();
		expect(command(screen)).toContain(`${GALOPIN_IMAGE}:${APP_VERSION}`);
		await userEvent.keyboard("{ArrowLeft}");
		await expect.element(radio(screen, NATIVE)).toBeChecked();
		expect(command(screen)).toBe(PLAIN);
	});

	it("what only makes sense on a computer is hidden in Docker: the download, Install opencode, the goose engine", async () => {
		const screen = mount();
		await expect.element(screen.getByText("Download manually")).toBeVisible();
		await expect.element(screen.getByTestId("enroll-install-opencode")).toBeVisible();
		await openAdvanced(screen);
		expect(screen.getByRole("option", { name: "goose" }).elements()).toHaveLength(1);

		await chooseDocker(screen);
		expect(screen.getByText("Download manually").elements()).toHaveLength(0);
		expect(screen.getByTestId("pair-download").elements()).toHaveLength(0);
		expect(screen.getByTestId("enroll-install-opencode").elements()).toHaveLength(0);
		expect(screen.getByRole("checkbox", { name: /Install opencode/ }).elements()).toHaveLength(0);
		expect(screen.getByRole("option", { name: "goose" }).elements()).toHaveLength(0);
		await expect.element(screen.getByTestId("enroll-engine")).toHaveValue("opencode");
		// Nor does the engine's help text talk about a goose that is not in the image.
		expect(screen.getByTestId("enroll-advanced").element().textContent).not.toMatch(/goose/i);

		await chooseNative(screen);
		await expect.element(screen.getByText("Download manually")).toBeVisible();
		await expect.element(screen.getByTestId("enroll-install-opencode")).toBeVisible();
		expect(screen.getByRole("option", { name: "goose" }).elements()).toHaveLength(1);
	});

	it("a goose choice never leaks into the Docker command: it is reset to opencode, and stays so on the way back", async () => {
		const screen = mount();
		await openAdvanced(screen);
		await screen.getByTestId("enroll-engine").selectOptions("goose");
		expect(command(screen)).toContain("--engine goose");

		await chooseDocker(screen);
		expect(command(screen)).not.toContain("--engine");
		expect(command(screen)).toBe(dockerCommand({ billToDefault: true }));
		await expect.element(screen.getByTestId("enroll-engine")).toHaveValue("opencode");

		await chooseNative(screen);
		await expect.element(screen.getByTestId("enroll-engine")).toHaveValue("opencode");
		expect(command(screen)).toBe(PLAIN);
	});

	it("Install opencode ticked on the computer adds nothing in Docker", async () => {
		const screen = mount();
		await screen.getByTestId("enroll-install-opencode").click();
		expect(command(screen)).toContain("--with-opencode");
		await chooseDocker(screen);
		expect(command(screen)).not.toContain("--with-opencode");
		expect(command(screen)).toBe(dockerCommand({ billToDefault: true }));
	});

	it("the computer name: shown only in Docker, 'sandbox' to start with, cleaned into --hostname", async () => {
		const screen = mount();
		await chooseDocker(screen);
		const name = screen.getByTestId("pair-docker-name");
		await expect.element(name).toHaveValue("sandbox");
		await name.fill("My Build_Box 2");
		expect(command(screen)).toContain("--hostname my-build-box-2 \\\n");
		expect(command(screen)).toBe(dockerCommand({ billToDefault: true, name: "my-build-box-2" }));
		// A shell metacharacter never reaches the command.
		await name.fill("x; rm -rf /");
		expect(command(screen)).toContain("--hostname x-rm-rf ");
		expect(command(screen)).not.toContain("rm -rf /");
		// Nothing usable left: the default, not an empty --hostname.
		await name.fill("***");
		expect(command(screen)).toContain("--hostname sandbox ");
		// Leaving the field shows the name the command uses.
		await name.fill("CI Box");
		(name.element() as HTMLInputElement).blur();
		await expect.element(name).toHaveValue("ci-box");
	});

	it("the name follows the keep-pairing volume, and the name is not part of the native command", async () => {
		const screen = mount();
		await chooseDocker(screen);
		await screen.getByTestId("pair-docker-name").fill("lab");
		await screen.getByTestId("pair-docker-keep").click();
		expect(command(screen)).toContain("-v galopin-lab:/home/galopin");
		await chooseNative(screen);
		expect(command(screen)).toBe(PLAIN);
		expect(command(screen)).not.toContain("lab");
	});

	it("keeping the pairing is off to start with; ticking adds the volume line (and a restart note), unticking removes both", async () => {
		const screen = mount();
		await chooseDocker(screen);
		const keep = screen.getByTestId("pair-docker-keep");
		await expect.element(keep).not.toBeChecked();
		expect(command(screen)).not.toContain("-v galopin-");
		expect(screen.getByTestId("pair-docker-keep-note").elements()).toHaveLength(0);

		await keep.click();
		await expect.element(keep).toBeChecked();
		expect(command(screen)).toBe(dockerCommand({ billToDefault: true, keepPairing: true }));
		expect(command(screen)).toContain("-v galopin-sandbox:/home/galopin");
		await expect
			.element(screen.getByTestId("pair-docker-keep-note"))
			.toHaveTextContent("run the same command without start and the flags");

		await keep.click();
		expect(command(screen)).toBe(dockerCommand({ billToDefault: true }));
		expect(screen.getByTestId("pair-docker-keep-note").elements()).toHaveLength(0);
	});

	it("says workspace folders are paths inside the container, and that /workspace is the project", async () => {
		const screen = mount();
		expect(screen.getByTestId("pair-docker-paths").elements()).toHaveLength(0);
		await chooseDocker(screen);
		await expect
			.element(screen.getByTestId("pair-docker-paths"))
			.toHaveTextContent("paths inside the container");
		await expect.element(screen.getByTestId("pair-docker-paths")).toHaveTextContent("/workspace");
		expect(command(screen)).toContain('-v "$PWD":/workspace');
	});

	it("the policy flags are the same in both modes, whatever is chosen", async () => {
		const screen = mount();
		await openAdvanced(screen);
		await screen.getByTestId("enroll-allow-project-config").click();
		await screen.getByTestId("enroll-allow-command-shell").click();
		await screen.getByTestId("enroll-no-files").click();
		await screen.getByTestId("enroll-bill-to-default").click();
		await screen.getByTestId("enroll-max-terminals").fill("3");
		const list = screen.getByTestId("enroll-workspace-roots");
		await list.getByRole("button", { name: "Add" }).click();
		await list.getByRole("textbox", { name: "Workspace folders. 1" }).fill("/workspace/my app");
		const native = policyPart(screen);
		expect(native).toBe(
			"--max-terminals 3 --allow-project-config --no-command-shell --workspace-root '/workspace/my app' --no-files"
		);

		await chooseDocker(screen);
		expect(policyPart(screen)).toBe(native);
		// The controls keep what was chosen, so a flag turned off in Docker goes too.
		await expect.element(screen.getByTestId("enroll-no-files")).toBeChecked();
		await screen.getByTestId("enroll-no-files").click();
		expect(policyPart(screen)).not.toContain("--no-files");

		await chooseNative(screen);
		expect(policyPart(screen)).not.toContain("--no-files");
		expect(policyPart(screen)).toContain("--allow-project-config");
		await screen.getByTestId("enroll-no-files").click();
		expect(policyPart(screen)).toBe(native);
	});

	it("switching back restores the native command and its explanation, untouched", async () => {
		const screen = mount();
		await chooseDocker(screen);
		await screen.getByTestId("pair-docker-keep").click();
		await chooseNative(screen);
		expect(command(screen)).toBe(PLAIN);
		await expect
			.element(screen.getByTestId("pair-explain"))
			.toHaveTextContent("signs the computer into your account");
		await expect.element(screen.getByText("Install, enroll and run")).toBeVisible();
		expect(screen.getByTestId("pair-docker-options").elements()).toHaveLength(0);
	});

	it("remembers nothing: no storage is written, and a new dialog opens on this computer again", async () => {
		localStorage.clear();
		sessionStorage.clear();
		const first = mount();
		await chooseDocker(first);
		await first.getByTestId("pair-docker-keep").click();
		await first.getByTestId("pair-docker-name").fill("kept");
		expect(localStorage.length).toBe(0);
		expect(sessionStorage.length).toBe(0);
		expect(document.cookie).not.toMatch(/docker|pair/i);
		first.unmount();

		const second = mount();
		await expect.element(radio(second, NATIVE)).toBeChecked();
		expect(command(second)).toBe(PLAIN);
		second.unmount();
	});

	it("the pending list and its buttons are the same in both modes", async () => {
		const screen = mount();
		await chooseDocker(screen);
		await expect.element(screen.getByText("Waiting for confirmation")).toBeVisible();
		await expect.element(screen.getByText("No computer has checked in yet.")).toBeVisible();
	});
});
