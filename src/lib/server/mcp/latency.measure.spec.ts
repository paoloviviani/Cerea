import { describe, it, vi } from "vitest";
import { ObjectId } from "mongodb";

vi.mock("./elicitationConfig", () => ({
	isElicitationEnabled: () => true,
	getElicitationTimeoutMs: () => 30_000,
}));
vi.mock("./local", () => ({ localServerFingerprint: () => undefined }));
vi.mock("./localTransport", async () => {
	const { ChildLocalTransport } = await import("./testing/childLocalTransport");
	return { createLocalTransport: async () => new ChildLocalTransport() };
});

const { getClient } = await import("./clientPool");
const { callMcpTool } = await import("./httpClient");
const { machine } = await import("./testing/childLocalTransport");
const { localServerUrl } = await import("./localUrl");

const server = {
	name: "mail · on laptop",
	url: localServerUrl(new ObjectId().toString(), new ObjectId().toString(), "mail"),
};
const sink = () => ({ conversationId: new ObjectId(), emit: () => {} });

// A measurement, not a check: skipped unless MEASURE=1 (`MEASURE=1 npx vitest run --project=server
// latency.measure`). Counts what a few conversations cost against a stdio server that ignores
// the version probe: time to the first tool listing, time of each conversation's first call,
// and how many server processes the machine had to start.
describe.skipIf(!process.env.MEASURE)("local connector latency", () => {
	it("measures", { timeout: 900_000 }, async () => {
		const out: Record<string, number> = {};
		let t = performance.now();
		const lap = (name: string) => {
			out[name] = Math.round(performance.now() - t);
			t = performance.now();
		};
		await (await getClient(server)).listTools();
		lap("firstToolListingMs");
		for (const name of ["convA", "convB", "convC"]) {
			await callMcpTool(server, "echo", {}, { elicitation: { sink: sink(), toolUuid: name } });
			lap(`toolCall_${name}_Ms`);
		}
		out.processesStarted = machine.opens;
		console.log("MEASURE " + JSON.stringify(out));
	});
});
