import { describe, expect, it } from "vitest";
import {
	collectFileArtifacts,
	dedupeDeliverablesByName,
	findFileVersionBySha,
	withLiveRunFiles,
} from "./fileArtifacts";
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

describe("dedupeDeliverablesByName", () => {
	it("keeps the newest row per filename (input is newest-first)", () => {
		const rows = [
			{ name: "a.pdf", mime: "application/pdf", size: 12, sha256: "s2", createdAt: "t2" },
			{ name: "b.csv", mime: "text/csv", size: 3, sha256: "s3", createdAt: "t3" },
			{ name: "a.pdf", mime: "application/pdf", size: 10, sha256: "s1", createdAt: "t1" },
		];
		expect(dedupeDeliverablesByName(rows).map((r) => r.sha256)).toEqual(["s2", "s3"]);
	});
});

const outputs = (runKey: string, files: { name: string; size: number; sha256: string }[]) => ({
	type: MessageUpdateType.CodeExecution as const,
	subtype: MessageCodeExecutionUpdateType.Outputs as const,
	runKey,
	files,
});

describe("every produced file is a file artifact", () => {
	it("folds a code block's stored files in exactly like a tool run's", () => {
		// The case the user hit: "create a hello world docx" answered with an
		// auto-running code block, whose file never became an artifact.
		const registry = collectFileArtifacts([
			{
				id: "m1",
				from: "assistant" as const,
				updates: [outputs("chat:abc", [{ name: "hello_world.docx", size: 36_000, sha256: "d1" }])],
			},
			{
				id: "m2",
				from: "assistant" as const,
				updates: [resolved("e1", [{ name: "hello_world.docx", size: 37_000, sha256: "d2" }])],
			},
		]);
		const docx = registry.artifacts.get("hello_world.docx");
		// One artifact, two versions, whichever path produced each.
		expect(docx?.versions.map((v) => [v.sha256, v.version, v.messageId])).toEqual([
			["d1", 1, "m1"],
			["d2", 2, "m2"],
		]);
	});

	it("adds nothing for a byte-identical re-run of a block", () => {
		const registry = collectFileArtifacts([
			{
				id: "m1",
				from: "assistant" as const,
				updates: [
					outputs("chat:abc", [{ name: "a.pdf", size: 1, sha256: "s1" }]),
					outputs("chat:abc", [{ name: "a.pdf", size: 1, sha256: "s1" }]),
				],
			},
		]);
		expect(registry.artifacts.get("a.pdf")?.versions).toHaveLength(1);
	});
});

describe("withLiveRunFiles", () => {
	const message = (updates: ReturnType<typeof outputs>[] = []) => ({
		id: "m1",
		from: "assistant" as const,
		updates,
	});

	it("adds a record made in this tab to its message", () => {
		const live = { m1: [outputs("chat:abc", [{ name: "a.pdf", size: 1, sha256: "s1" }])] };
		const [merged] = withLiveRunFiles([message()], live);
		expect(collectFileArtifacts([merged]).artifacts.has("a.pdf")).toBe(true);
	});

	it("skips a record the loader already served, so it is never a version twice", () => {
		const record = outputs("chat:abc", [{ name: "a.pdf", size: 1, sha256: "s1" }]);
		const served = message([record]);
		const [merged] = withLiveRunFiles([served], { m1: [record] });
		expect(merged).toBe(served);
	});

	it("leaves every message without live records untouched", () => {
		const other = { id: "m2", from: "assistant" as const, updates: [] };
		const merged = withLiveRunFiles([message(), other], {
			m1: [outputs("chat:abc", [{ name: "a.pdf", size: 1, sha256: "s1" }])],
		});
		expect(merged[1]).toBe(other);
	});
});
