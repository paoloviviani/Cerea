import { describe, expect, it } from "vitest";
import { terminalKeyAction, type TerminalKeyEventShape } from "./terminalKeys";

function key(overrides: Partial<TerminalKeyEventShape>): TerminalKeyEventShape {
	return {
		type: "keydown",
		key: "c",
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		metaKey: false,
		isMac: false,
		hasSelection: false,
		...overrides,
	};
}

describe("terminalKeyAction", () => {
	it("sends SIGINT for Ctrl+C when nothing is selected", () => {
		expect(terminalKeyAction(key({ ctrlKey: true }))).toBe("passthrough");
	});

	it("lets the browser copy when Ctrl+C lands on a selection", () => {
		expect(terminalKeyAction(key({ ctrlKey: true, hasSelection: true }))).toBe("letBrowserCopy");
		expect(terminalKeyAction(key({ ctrlKey: true, hasSelection: true, isMac: true }))).toBe(
			"letBrowserCopy"
		);
		// macOS's own chord reaches the same decision.
		expect(terminalKeyAction(key({ metaKey: true, isMac: true, hasSelection: true }))).toBe(
			"letBrowserCopy"
		);
	});

	it("writes the clipboard itself for the terminal copy chord, any platform", () => {
		expect(terminalKeyAction(key({ ctrlKey: true, shiftKey: true }))).toBe("copySelection");
		expect(terminalKeyAction(key({ ctrlKey: true, shiftKey: true, isMac: true }))).toBe(
			"copySelection"
		);
		expect(terminalKeyAction(key({ ctrlKey: true, shiftKey: true, hasSelection: false }))).toBe(
			"copySelection"
		);
	});

	it("lets Ctrl+V paste instead of sending ^V", () => {
		expect(terminalKeyAction(key({ key: "v", ctrlKey: true }))).toBe("letBrowserPaste");
		expect(terminalKeyAction(key({ key: "v", ctrlKey: true, shiftKey: true }))).toBe(
			"letBrowserPaste"
		);
	});

	it("leaves macOS Cmd+V alone: the browser already pastes it", () => {
		expect(terminalKeyAction(key({ key: "v", metaKey: true, isMac: true }))).toBe("passthrough");
	});

	it("leaves Alt-modified combos to the shell", () => {
		expect(terminalKeyAction(key({ key: "v", ctrlKey: true, altKey: true }))).toBe("passthrough");
		expect(terminalKeyAction(key({ key: "c", ctrlKey: true, altKey: true }))).toBe("passthrough");
	});

	it("passes through every other key, and the keyup of an intercepted chord", () => {
		expect(terminalKeyAction(key({ key: "a", ctrlKey: true }))).toBe("passthrough");
		expect(terminalKeyAction(key({ key: "c", ctrlKey: true, type: "keyup" }))).toBe("passthrough");
		expect(terminalKeyAction(key({ key: "v", ctrlKey: true, type: "keyup" }))).toBe("passthrough");
	});
});
