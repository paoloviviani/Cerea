import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VIBE_LOCK_SHA256, VIBE_VERSION } from "./vibeVersion";

const packaging = (name: string) =>
	readFileSync(fileURLToPath(new URL(`../../agent/packaging/${name}`, import.meta.url)));

describe("the pinned Mistral Vibe release", () => {
	it("is the one in agent/packaging/vibe-version, which galopin reports and CI tests", () => {
		const pinned = packaging("vibe-version").toString("utf8");
		expect(pinned).toMatch(/^\d+\.\d+\.\d+\n$/);
		expect(VIBE_VERSION).toBe(pinned.trim());
	});

	it("has the sha256 of agent/packaging/vibe-requirements.txt, which pins every package by hash", () => {
		const lock = packaging("vibe-requirements.txt");
		expect(VIBE_LOCK_SHA256).toBe(createHash("sha256").update(lock).digest("hex"));
		const text = lock.toString("utf8");
		expect(text).toContain(`mistral-vibe==${VIBE_VERSION} `);
		// every requirement carries hashes, and none names an index or a VCS source
		const blocks = text.trim().split(/\n(?=[A-Za-z0-9_.-]+(?:\[[^\]]*\])?==)/);
		expect(blocks.length).toBeGreaterThan(20);
		for (const block of blocks) {
			expect(block, block.slice(0, 60)).toMatch(/--hash=sha256:[0-9a-f]{64}/);
		}
		expect(text).not.toMatch(/--index-url|--extra-index-url|git\+|https?:\/\//);
	});
});
