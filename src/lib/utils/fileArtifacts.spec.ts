import { describe, expect, it } from "vitest";
import { collectFileArtifacts, findFileVersionBySha } from "./fileArtifacts";
import { MessageCodeExecutionUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";

const resolved = (
	executionId: string,
	files: { name: string; size: number; sha256: string }[]
) => ({
	type: MessageUpdateType.CodeExecution as const,
	subtype: MessageCodeExecutionUpdateType.Resolved as const,
	executionId,
	outcome: { ok: true, stdout: "", stderr: "" },
	files,
});

describe("collectFileArtifacts", () => {
	it("returns an empty registry when no run persisted files", () => {
		expect(collectFileArtifacts([]).artifacts.size).toBe(0);
		expect(
			collectFileArtifacts([{ id: "m1", from: "assistant" as const, updates: [] }]).artifacts.size
		).toBe(0);
	});

	it("registers one artifact per filename with versions in message order", () => {
		const registry = collectFileArtifacts([
			{
				id: "m1",
				from: "assistant" as const,
				updates: [resolved("e1", [{ name: "a.pdf", size: 10, sha256: "s1" }])],
			},
			{
				id: "m2",
				from: "assistant" as const,
				updates: [
					resolved("e2", [
						{ name: "a.pdf", size: 12, sha256: "s2" },
						{ name: "b.csv", size: 5, sha256: "s3" },
					]),
				],
			},
		]);
		expect(registry.artifacts.get("a.pdf")?.versions.map((v) => v.sha256)).toEqual(["s1", "s2"]);
		expect(registry.artifacts.get("a.pdf")?.versions.map((v) => v.version)).toEqual([1, 2]);
		expect(registry.artifacts.get("a.pdf")?.versions[1].messageId).toBe("m2");
		expect(registry.artifacts.get("b.csv")?.versions).toHaveLength(1);
	});

	it("ignores user messages, requests, and updates without files", () => {
		const registry = collectFileArtifacts([
			{
				id: "m1",
				from: "user" as const,
				updates: [resolved("e1", [{ name: "a.pdf", size: 10, sha256: "s1" }])],
			},
			{
				id: "m2",
				from: "assistant" as const,
				updates: [
					{
						type: MessageUpdateType.CodeExecution as const,
						subtype: MessageCodeExecutionUpdateType.Request as const,
						executionId: "e2",
						code: "1+1",
					},
				],
			},
		]);
		expect(registry.artifacts.size).toBe(0);
	});

	it("does not add a version for a byte-identical re-run", () => {
		const registry = collectFileArtifacts([
			{
				id: "m1",
				from: "assistant" as const,
				updates: [resolved("e1", [{ name: "a.pdf", size: 10, sha256: "s1" }])],
			},
			{
				id: "m2",
				from: "assistant" as const,
				updates: [resolved("e2", [{ name: "a.pdf", size: 10, sha256: "s1" }])],
			},
			{
				id: "m3",
				from: "assistant" as const,
				updates: [resolved("e3", [{ name: "a.pdf", size: 11, sha256: "s2" }])],
			},
		]);
		expect(registry.artifacts.get("a.pdf")?.versions.map((v) => v.sha256)).toEqual(["s1", "s2"]);
	});

	it("skips refs with no name or sha", () => {
		const registry = collectFileArtifacts([
			{
				id: "m1",
				from: "assistant" as const,
				updates: [resolved("e1", [{ name: "", size: 0, sha256: "" }])],
			},
		]);
		expect(registry.artifacts.size).toBe(0);
	});
});

describe("findFileVersionBySha", () => {
	it("locates the artifact version carrying these bytes", () => {
		const registry = collectFileArtifacts([
			{
				id: "m1",
				from: "assistant" as const,
				updates: [resolved("e1", [{ name: "a.pdf", size: 10, sha256: "s1" }])],
			},
			{
				id: "m2",
				from: "assistant" as const,
				updates: [resolved("e2", [{ name: "a.pdf", size: 12, sha256: "s2" }])],
			},
		]);
		expect(findFileVersionBySha(registry, "s2")).toEqual({ name: "a.pdf", version: 2 });
		expect(findFileVersionBySha(registry, "missing")).toBeUndefined();
	});
});
