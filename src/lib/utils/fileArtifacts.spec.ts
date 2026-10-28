/* eslint-disable @typescript-eslint/no-non-null-assertion -- assertions on values the test just created */
import { describe, expect, it } from "vitest";
import {
	collectFileArtifacts,
	dedupeDeliverablesByName,
	findFileVersionBySha,
	findFileVersionsBySha,
	withLiveRunFiles,
} from "./fileArtifacts";
import { MessageCodeExecutionUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";

const resolved = (
	executionId: string,
	files: { name: string; size: number; sha256: string; uploaded?: boolean }[]
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

describe("sub-directories, shared bytes and unsaved files", () => {
	const msg = (
		id: string,
		files: { name: string; size: number; sha256: string; uploaded?: boolean }[]
	) => ({
		id,
		from: "assistant" as const,
		updates: [resolved(`e-${id}`, files)],
	});

	it("keeps a/x.pdf and b/x.pdf as two artifacts", () => {
		const registry = collectFileArtifacts([
			msg("m1", [
				{ name: "a/x.pdf", size: 1, sha256: "s1" },
				{ name: "b/x.pdf", size: 2, sha256: "s2" },
			]),
		]);
		expect([...registry.artifacts.keys()]).toEqual(["a/x.pdf", "b/x.pdf"]);
		expect(findFileVersionBySha(registry, "s2")).toEqual({ name: "b/x.pdf", version: 1 });
	});

	it("resolves identical bytes under two names to the name asked for, not the first", () => {
		const registry = collectFileArtifacts([
			msg("m1", [
				{ name: "a.csv", size: 1, sha256: "same" },
				{ name: "b.csv", size: 1, sha256: "same" },
			]),
		]);
		expect(findFileVersionsBySha(registry, "same")).toEqual([
			{ name: "a.csv", version: 1 },
			{ name: "b.csv", version: 1 },
		]);
		expect(findFileVersionBySha(registry, "same", "b.csv")).toEqual({ name: "b.csv", version: 1 });
		expect(findFileVersionBySha(registry, "same")).toEqual({ name: "a.csv", version: 1 });
	});

	it("carries uploaded: false and lets a later stored record of the same bytes upgrade it", () => {
		const registry = collectFileArtifacts([
			msg("m1", [{ name: "r.csv", size: 1, sha256: "s", uploaded: false }]),
			msg("m1b", [{ name: "r.csv", size: 1, sha256: "s", uploaded: true }]),
		]);
		const versions = registry.artifacts.get("r.csv")!.versions;
		expect(versions).toHaveLength(1);
		expect(versions[0].uploaded).toBe(true);
		const lost = collectFileArtifacts([
			msg("m1", [{ name: "r.csv", size: 1, sha256: "s", uploaded: false }]),
		]);
		expect(lost.artifacts.get("r.csv")!.versions[0].uploaded).toBe(false);
	});

	it("reads an old reference without the field as stored", () => {
		const registry = collectFileArtifacts([msg("m1", [{ name: "old.csv", size: 1, sha256: "s" }])]);
		expect(registry.artifacts.get("old.csv")!.versions[0].uploaded).toBeUndefined();
	});

	it("treats the same file produced again with other bytes as the next version", () => {
		const registry = collectFileArtifacts([
			msg("m1", [{ name: "r.csv", size: 1, sha256: "s1" }]),
			msg("m2", [{ name: "r.csv", size: 2, sha256: "s2" }]),
		]);
		expect(registry.artifacts.get("r.csv")!.versions.map((v) => v.version)).toEqual([1, 2]);
	});
});

describe("withLiveRunFiles: live entries feed the registry", () => {
	const base = { id: "m1", from: "assistant" as const, updates: [] as never[] };
	const outputs = (
		runKey: string,
		files: { name: string; size: number; sha256: string; uploaded?: boolean }[]
	) => ({
		type: MessageUpdateType.CodeExecution as const,
		subtype: MessageCodeExecutionUpdateType.Outputs as const,
		runKey,
		files,
	});

	it("registers a live file before any server record exists", () => {
		const merged = withLiveRunFiles([base], {
			m1: [outputs("chat:1", [{ name: "x.pdf", size: 1, sha256: "s" }])],
		});
		expect(collectFileArtifacts(merged).artifacts.get("x.pdf")?.versions).toHaveLength(1);
	});

	it("does not add a tool run's file a second time from its live entry", () => {
		const message = {
			...base,
			updates: [resolved("e1", [{ name: "x.pdf", size: 1, sha256: "s" }])] as never[],
		};
		const merged = withLiveRunFiles([message], {
			m1: [outputs("chat:1", [{ name: "x.pdf", size: 1, sha256: "s" }])],
		});
		expect(merged[0].updates).toHaveLength(1);
	});

	it("lets a record that says stored through when the server only had it as unsaved", () => {
		const message = {
			...base,
			updates: [
				resolved("e1", [{ name: "x.pdf", size: 1, sha256: "s", uploaded: false }]),
			] as never[],
		};
		const merged = withLiveRunFiles([message], {
			m1: [outputs("chat:1", [{ name: "x.pdf", size: 1, sha256: "s", uploaded: true }])],
		});
		expect(collectFileArtifacts(merged).artifacts.get("x.pdf")!.versions[0].uploaded).toBe(true);
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

	it("keeps the row that last became current: a restored older version beats a newer one", () => {
		const rows = [
			{ name: "a.pdf", sha256: "v3", createdAt: "2026-10-28T10:10:00Z" },
			{
				name: "a.pdf",
				sha256: "v2",
				createdAt: "2026-10-28T10:00:00Z",
				latestAt: "2026-10-28T10:20:00Z",
			},
		];
		expect(dedupeDeliverablesByName(rows).map((r) => r.sha256)).toEqual(["v2"]);
	});
});

const outputs = (
	runKey: string,
	files: { name: string; size: number; sha256: string; uploaded?: boolean }[]
) => ({
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

	it("an orphan record under an abandoned client id never becomes a second version", () => {
		// The race finding 1 fixes: a run settles and claims under the message's
		// client-minted id, is refused (that id was never saved), and the same
		// run's bytes are recorded again once the id swaps to the server's. Both
		// attempts share this tab's `runFiles` live store, so if the failed
		// attempt had somehow left an entry under the old id too, it must not
		// resurface as a second version once folded through the same messages
		// the real conversation actually has (which the abandoned id is not one
		// of — only the server's message ever lands there).
		const served = message();
		const live = {
			"client-minted-id": [outputs("chat:abc", [{ name: "a.pdf", size: 1, sha256: "s1" }])],
			m1: [outputs("chat:abc", [{ name: "a.pdf", size: 1, sha256: "s1" }])],
		};
		const merged = withLiveRunFiles([served], live);
		const registry = collectFileArtifacts(merged);
		expect(registry.artifacts.get("a.pdf")?.versions).toHaveLength(1);
		expect(registry.artifacts.get("a.pdf")?.versions[0].messageId).toBe("m1");
	});
});
