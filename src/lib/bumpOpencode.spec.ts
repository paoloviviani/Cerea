// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repo = resolve(__dirname, "../..");
const archives = [
	"opencode-linux-x64.tar.gz",
	"opencode-linux-x64-baseline.tar.gz",
	"opencode-linux-x64-musl.tar.gz",
	"opencode-linux-x64-baseline-musl.tar.gz",
	"opencode-linux-arm64.tar.gz",
	"opencode-linux-arm64-musl.tar.gz",
	"opencode-darwin-x64.zip",
	"opencode-darwin-x64-baseline.zip",
	"opencode-darwin-arm64.zip",
];

describe("agent/packaging/bump-opencode.sh", () => {
	const root = mkdtempSync(join(tmpdir(), "bump-opencode-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("moves the pin, records the checksums and leaves opencodeVersion.ts as prettier writes it", () => {
		mkdirSync(join(root, "agent/packaging"), { recursive: true });
		mkdirSync(join(root, "src/lib"), { recursive: true });
		cpSync(
			join(repo, "agent/packaging/bump-opencode.sh"),
			join(root, "agent/packaging/bump-opencode.sh")
		);
		for (const f of ["codeEnrollCommand.ts", "opencodeVersion.ts"])
			cpSync(join(repo, "src/lib", f), join(root, "src/lib", f));
		for (const f of [".prettierrc", ".prettierignore"])
			if (existsSync(join(repo, f))) cpSync(join(repo, f), join(root, f));
		// the tailwind prettier plugin reads the stylesheet the config names
		mkdirSync(join(root, "src/styles"), { recursive: true });
		writeFileSync(join(root, "src/styles/main.css"), '@import "tailwindcss";\n');
		symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));

		// fake release downloads, served from disk
		const dl = join(root, "dl/v9.9.9");
		mkdirSync(dl, { recursive: true });
		const sums: Record<string, string> = {};
		for (const name of archives) {
			const body = `fake ${name}`;
			writeFileSync(join(dl, name), body);
			sums[name] = createHash("sha256").update(body).digest("hex");
		}

		execFileSync("sh", [join(root, "agent/packaging/bump-opencode.sh"), "9.9.9"], {
			env: { ...process.env, OPENCODE_DL_BASE: `file://${join(root, "dl")}` },
			stdio: "pipe",
		});

		expect(readFileSync(join(root, "agent/packaging/opencode-version"), "utf8").trim()).toBe(
			"9.9.9"
		);
		expect(readFileSync(join(root, "src/lib/codeEnrollCommand.ts"), "utf8")).toContain(
			'export const OPENCODE_VERSION = "9.9.9";'
		);
		const ts = readFileSync(join(root, "src/lib/opencodeVersion.ts"), "utf8");
		for (const [name, sum] of Object.entries(sums)) expect(ts).toContain(sum);
		for (const name of archives) expect(ts).toContain(`"${name}"`);
		// a second run over the formatted file still works, and prettier has nothing to change
		execFileSync("sh", [join(root, "agent/packaging/bump-opencode.sh"), "9.9.9"], {
			env: { ...process.env, OPENCODE_DL_BASE: `file://${join(root, "dl")}` },
			stdio: "pipe",
		});
		execFileSync(
			join(repo, "node_modules/.bin/prettier"),
			["--check", join(root, "src/lib/opencodeVersion.ts")],
			{
				cwd: root,
				stdio: "pipe",
			}
		);
	});
});
