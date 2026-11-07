import { describe, expect, it } from "vitest";
import { analyseCommand, summarizeApproval } from "./approvalSummary";

describe("analyseCommand", () => {
	it("names a download piped into a shell", () => {
		const out = analyseCommand("curl -s https://example.com/install.sh | sh");
		expect(out.title).toBe("Download and run an online script");
		expect(out.extra).toEqual(["network", "runs"]);
	});

	it("names what a delete removes", () => {
		expect(analyseCommand("rm -rf /work/shop-api/.pytest_cache")).toEqual({
			title: "Delete the folder .pytest_cache",
			extra: ["deletes"],
		});
		expect(analyseCommand("rm notes.txt").title).toBe("Delete the file notes.txt");
	});

	it("adds secrets and network warnings without hiding the command", () => {
		expect(analyseCommand("cat ~/.ssh/id_rsa").extra).toContain("secrets");
		expect(analyseCommand("pip install requests").extra).toEqual(["network"]);
		expect(analyseCommand("python3 -m pytest -v").title).toBe("Run: python3 -m pytest -v");
	});
});

describe("summarizeApproval", () => {
	it("tags a plain bash ask as running commands, and the machine's read-only stamp as read-only", () => {
		expect(summarizeApproval({ tool: "bash", args: { command: "ls" } }).tags).toEqual(["runs"]);
		expect(
			summarizeApproval({
				tool: "bash",
				args: { command: "git status" },
				class: "command",
				readOnly: true,
			}).tags
		).toEqual(["readonly"]);
	});

	it("never lets the read-only stamp hide a delete", () => {
		const out = summarizeApproval({
			tool: "bash",
			args: { command: "rm -rf build/" },
			readOnly: true,
		});
		expect(out.title).toBe("Delete the folder build");
		expect(out.tags).toContain("deletes");
		expect(out.tags).not.toContain("readonly");
	});

	it("uses the machine's class when the tool name says nothing", () => {
		expect(summarizeApproval({ tool: "weird", args: {}, class: "web" }).tags).toEqual(["network"]);
		expect(summarizeApproval({ tool: "edit", args: { filepath: "/w/src/cart.py" } })).toMatchObject(
			{
				title: "Change cart.py",
				tags: ["changes"],
			}
		);
	});

	it("reads a connector ask in chat", () => {
		expect(
			summarizeApproval({ tool: "Team notes:search_notes", args: { query: "release" }, chat: true })
		).toEqual({ title: 'Team notes wants to search notes for "release"', tags: ["readonly"] });
		expect(
			summarizeApproval({ tool: "Team notes:create_task", args: { title: "x" }, chat: true }).tags
		).toEqual(["connector"]);
	});
});
