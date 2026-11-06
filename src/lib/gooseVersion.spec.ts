import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GOOSE_SHA256, GOOSE_VERSION } from "./gooseVersion";

const packaging = (name: string) =>
	readFileSync(fileURLToPath(new URL(`../../agent/packaging/${name}`, import.meta.url)), "utf8");

describe("the pinned goose release", () => {
	it("is the one in agent/packaging/goose-version, which galopin reports and CI tests", () => {
		const pinned = packaging("goose-version");
		expect(pinned).toMatch(/^\d+\.\d+\.\d+\n$/);
		expect(GOOSE_VERSION).toBe(pinned.trim());
	});

	it("has the same archive checksums as agent/packaging/goose-sha256", () => {
		const file = new Map(
			packaging("goose-sha256")
				.trim()
				.split("\n")
				.map((line) => {
					const [sum, name] = line.split(/\s+/);
					return [name, sum] as const;
				})
		);
		expect(Object.fromEntries(file)).toEqual(GOOSE_SHA256);
		expect([...file.keys()].sort()).toEqual([
			"goose-aarch64-apple-darwin.tar.gz",
			"goose-aarch64-unknown-linux-gnu.tar.gz",
			"goose-x86_64-apple-darwin.tar.gz",
			"goose-x86_64-unknown-linux-gnu.tar.gz",
		]);
		for (const sum of file.values()) expect(sum).toMatch(/^[0-9a-f]{64}$/);
	});
});
