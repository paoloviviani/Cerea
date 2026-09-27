import { describe, expect, it } from "vitest";
import {
	SlashCommandState,
	matchSlashCommand,
	panelCommands,
	type SlashCommand,
} from "./slashCommand.svelte";

const COMMANDS: SlashCommand[] = [
	{ name: "compact", description: "Compact now", group: "panel" },
	{ name: "mode", description: "Switch the mode", hint: "[mode]", group: "panel" },
	{ name: "model", description: "Switch the model", hint: "[model]", group: "panel" },
	{ name: "new", description: "New agent", group: "panel" },
];

const find = (name: string): SlashCommand => {
	const found = COMMANDS.find((c) => c.name === name);
	if (!found) throw new Error(`no such command ${name}`);
	return found;
};

describe("SlashCommandState", () => {
	it("opens on a leading slash and shows every command for a bare one", () => {
		const slash = new SlashCommandState();
		slash.setCommands(COMMANDS);
		slash.update("/", 1);
		expect(slash.open).toBe(true);
		expect(slash.results.map((c) => c.name)).toEqual(["compact", "mode", "model", "new"]);
		expect(slash.activeIndex).toBe(-1);
	});

	it("does not open for a slash that is not the draft's first character", () => {
		const slash = new SlashCommandState();
		slash.setCommands(COMMANDS);
		slash.update("run /compact", 11);
		expect(slash.open).toBe(false);
	});

	it("`//` at the very start escapes to a literal slash", () => {
		const slash = new SlashCommandState();
		slash.setCommands(COMMANDS);
		slash.update("//etc/hosts is wrong", 5);
		expect(slash.open).toBe(false);
	});

	it("closes once the caret crosses the first token", () => {
		const slash = new SlashCommandState();
		slash.setCommands(COMMANDS);
		slash.update("/model", 6);
		expect(slash.open).toBe(true);

		// A space typed after the command word: the menu's work is done.
		slash.update("/model ", 7);
		expect(slash.open).toBe(false);

		// Mid-token carats stay open, with the query cut at the caret.
		slash.update("/model", 3);
		expect(slash.open).toBe(true);
		expect(slash.token?.query).toBe("mo");
	});

	it("filters by prefix first, then substring", () => {
		const slash = new SlashCommandState();
		slash.setCommands([
			{ name: "mode", description: "", group: "panel" },
			{ name: "model", description: "", group: "panel" },
			{ name: "remodel", description: "", group: "panel" },
		]);
		slash.update("/mod", 4);
		// Both `mode` and `model` start with the query; `remodel` only contains it.
		expect(slash.results.map((c) => c.name)).toEqual(["mode", "model", "remodel"]);

		slash.update("/del", 4);
		// `mo-del` contains the query as much as `re-model` does: both are
		// substring matches, in list order.
		expect(slash.results.map((c) => c.name)).toEqual(["model", "remodel"]);
	});

	it("matching is case-insensitive in both directions", () => {
		const slash = new SlashCommandState();
		slash.setCommands(COMMANDS);
		slash.update("/COMPACT", 8);
		expect(slash.results.map((c) => c.name)).toEqual(["compact"]);
	});

	it("Enter accepts nothing until the user has arrowed into the list", () => {
		const slash = new SlashCommandState();
		slash.setCommands(COMMANDS);
		slash.update("/", 1);
		expect(slash.activeResult).toBeUndefined();

		slash.move(1);
		expect(slash.activeIndex).toBe(0);
		expect(slash.activeResult?.name).toBe("compact");

		// Wrapping: back from the first lands on the last.
		slash.move(-1);
		expect(slash.activeIndex).toBe(3);
	});

	it("accept works without arrowing, which is Tab's contract", () => {
		const slash = new SlashCommandState();
		slash.setCommands(COMMANDS);
		slash.update("/mo", 3);
		const replacement = slash.accept("/mo", find("mode"));
		expect(replacement?.value).toBe("/mode ");
		expect(replacement?.caret).toBe("/mode ".length);
	});

	it("accept inserts the name plus a space and closes the panel", () => {
		const slash = new SlashCommandState();
		slash.setCommands(COMMANDS);
		slash.update("/comp", 5);
		const replacement = slash.accept("/comp", find("compact"));
		expect(replacement?.value).toBe("/compact ");
		expect(slash.open).toBe(false);
	});

	it("a completed command does not re-open at the next update", () => {
		const slash = new SlashCommandState();
		slash.setCommands(COMMANDS);
		slash.update("/mo", 3);
		const replacement = slash.accept("/mo", find("model"));

		// The caret lands after the inserted space; clicks and key-ups re-run
		// update, and the settled token must not reopen the menu.
		slash.update(replacement?.value ?? "", replacement?.caret ?? 0);
		expect(slash.open).toBe(false);
	});

	it("accept keeps any arguments that already follow the token", () => {
		// Only reachable when the caret returns into the first token of a
		// draft that already carries arguments — the rest's own space is the
		// separator, so accepting never doubles it.
		const slash = new SlashCommandState();
		slash.setCommands(COMMANDS);
		slash.update("/model g", 3);
		const replacement = slash.accept("/model g", find("model"));
		expect(replacement?.value).toBe("/model g");
		expect(replacement?.caret).toBe("/model ".length);
	});

	it("stays dismissed after Escape until the query changes", () => {
		const slash = new SlashCommandState();
		slash.setCommands(COMMANDS);
		slash.update("/comp", 5);
		slash.dismiss();
		expect(slash.open).toBe(false);

		// A click back into the same token does not undo the dismissal.
		slash.update("/comp", 5);
		expect(slash.open).toBe(false);

		// Typing more of it is a new query, so suggestions may return.
		slash.update("/compa", 6);
		expect(slash.open).toBe(true);
	});

	it("closes when a programmatic write removes the tracked token", () => {
		// The composer clears the draft after a command runs; no input event
		// fires, so syncValue has to notice on its own.
		const slash = new SlashCommandState();
		slash.setCommands(COMMANDS);
		slash.update("/comp", 5);
		expect(slash.open).toBe(true);

		slash.syncValue("");
		expect(slash.open).toBe(false);
		expect(slash.results).toEqual([]);
	});

	it("stays open through syncValue while the token is still there", () => {
		const slash = new SlashCommandState();
		slash.setCommands(COMMANDS);
		slash.update("/comp", 5);
		slash.syncValue("/comp");
		expect(slash.open).toBe(true);
	});

	it("the ghost hint lives exactly as long as the accepted token", () => {
		const slash = new SlashCommandState();
		slash.setCommands(COMMANDS);
		slash.update("/mod", 4);
		const replacement = slash.accept("/mod", find("model"));

		expect(slash.ghostHint(replacement?.value ?? "")).toBe("[model]");
		expect(slash.ghostHint("/model")).toBe("[model]");
		// The first typed argument retires it.
		expect(slash.ghostHint("/model gpt")).toBeNull();
		// An unrelated draft never shows a stale hint.
		expect(slash.ghostHint("/compact ")).toBeNull();
	});

	it("a command without a hint renders no ghost text", () => {
		const slash = new SlashCommandState();
		slash.setCommands(COMMANDS);
		slash.update("/comp", 5);
		const replacement = slash.accept("/comp", find("compact"));
		expect(slash.ghostHint(replacement?.value ?? "")).toBeNull();
	});

	it("an empty command list keeps the menu shut", () => {
		const slash = new SlashCommandState();
		slash.setCommands([]);
		slash.update("/", 1);
		expect(slash.open).toBe(false);
	});
});

describe("matchSlashCommand", () => {
	it("parses a bare command and one with arguments", () => {
		expect(matchSlashCommand("/compact", COMMANDS)?.command.name).toBe("compact");
		expect(matchSlashCommand("/compact", COMMANDS)?.args).toBe("");

		const model = matchSlashCommand("/model gpt-5", COMMANDS);
		expect(model?.command.name).toBe("model");
		expect(model?.args).toBe("gpt-5");
	});

	it("matches the name case-insensitively and trims the arguments", () => {
		const run = matchSlashCommand("/MODE   build  ", COMMANDS);
		expect(run?.command.name).toBe("mode");
		expect(run?.args).toBe("build");
	});

	it("leaves anything that is not a known command as ordinary text", () => {
		expect(matchSlashCommand("/etc/hosts is wrong", COMMANDS)).toBeNull();
		expect(matchSlashCommand("/foo", COMMANDS)).toBeNull();
		expect(matchSlashCommand("//x", COMMANDS)).toBeNull();
		expect(matchSlashCommand("hello /compact", COMMANDS)).toBeNull();
		expect(matchSlashCommand("/", COMMANDS)).toBeNull();
	});
});

/**
 * The panel command table the agent composer feeds the menu, gated on what
 * the agent's backend reports. What is pinned: the full seven when every
 * capability is on, the exact trims when one is off, and that model, mode
 * and new are never gated — a composer that can prompt can always reach its
 * pickers and the create dialog.
 */
describe("panelCommands", () => {
	it("lists all seven commands with every capability on", () => {
		expect(
			panelCommands({ compact: true, revert: true, efforts: true }).map((c) => c.name)
		).toEqual(["compact", "undo", "redo", "model", "mode", "effort", "new"]);
	});

	it("drops compact without the compact capability", () => {
		const names = panelCommands({ compact: false, revert: true, efforts: true }).map((c) => c.name);
		expect(names).toEqual(["undo", "redo", "model", "mode", "effort", "new"]);
	});

	it("drops undo and redo without the revert capability", () => {
		const names = panelCommands({ compact: true, revert: false, efforts: true }).map((c) => c.name);
		expect(names).toEqual(["compact", "model", "mode", "effort", "new"]);
	});

	it("drops effort without the efforts capability", () => {
		const names = panelCommands({ compact: true, revert: true, efforts: false }).map((c) => c.name);
		expect(names).toEqual(["compact", "undo", "redo", "model", "mode", "new"]);
	});

	it("model, mode and new are never gated", () => {
		const names = panelCommands({ compact: false, revert: false, efforts: false }).map(
			(c) => c.name
		);
		expect(names).toEqual(["model", "mode", "new"]);
	});

	it("the argument-taking commands carry their hints for the ghost text", () => {
		const withHints = panelCommands({ compact: true, revert: true, efforts: true }).filter(
			(c) => c.hint
		);
		expect(withHints.map((c) => `${c.name} ${c.hint}`)).toEqual([
			"model [model]",
			"mode [mode]",
			"effort [level]",
		]);
	});
});
