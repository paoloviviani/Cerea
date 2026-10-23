import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ObjectId } from "mongodb";

const fingerprint = vi.hoisted(() => ({ value: "entry-1" as string | undefined }));

vi.mock("./elicitationConfig", () => ({
	isElicitationEnabled: () => true,
	getElicitationTimeoutMs: () => 30_000,
}));
vi.mock("./local", () => ({ localServerFingerprint: () => fingerprint.value }));
vi.mock("./localTransport", async () => {
	const { ChildLocalTransport, machine } = await import("./testing/childLocalTransport");
	return {
		createLocalTransport: async (_url: string, onConfigClosed?: () => void) => {
			machine.onConfigClosed.push(onConfigClosed);
			return new ChildLocalTransport();
		},
	};
});

const { getClient, drainPool } = await import("./clientPool");
const { machine, resetMachine } = await import("./testing/childLocalTransport");
const { localServerUrl } = await import("./localUrl");
const { LOCAL_PROBE_TIMEOUT_MS, resetLocalEras } = await import("./localEra");

const server = {
	name: "mail · on laptop",
	url: localServerUrl(new ObjectId().toString(), new ObjectId().toString(), "mail"),
};

/** One connect on a fresh pool, and how long it took. */
async function connect() {
	await drainPool();
	const started = performance.now();
	const client = await getClient(server);
	const tools = await client.listTools();
	return { ms: performance.now() - started, era: client.getProtocolEra(), tools };
}

describe("the protocol era of a local server", () => {
	beforeEach(() => {
		resetMachine();
		resetLocalEras();
		fingerprint.value = "entry-1";
	});
	afterEach(drainPool);

	it("is found out within the short probe timeout when the server ignores the probe", async () => {
		const { ms, era, tools } = await connect();
		expect(era).toBe("legacy");
		expect(tools.tools.map((t) => t.name)).toEqual(["echo", "ask"]);
		// Against the SDK's 60 s default this took a minute.
		expect(ms).toBeLessThan(LOCAL_PROBE_TIMEOUT_MS + 3_000);
		// The handshake carries on over the same channel: no second process is started.
		expect(machine.opens).toBe(1);
	}, 20_000);

	it("is remembered, so a reconnect does not probe again", async () => {
		const first = await connect();
		expect(first.ms).toBeGreaterThanOrEqual(LOCAL_PROBE_TIMEOUT_MS - 500);
		const second = await connect();
		expect(second.era).toBe("legacy");
		expect(second.ms).toBeLessThan(LOCAL_PROBE_TIMEOUT_MS / 2);
	}, 30_000);

	it("is forgotten when the machine closes the channel because the entry changed", async () => {
		await connect();
		machine.onConfigClosed.at(-1)?.();
		const again = await connect();
		expect(again.ms).toBeGreaterThanOrEqual(LOCAL_PROBE_TIMEOUT_MS - 500);
	}, 30_000);

	it("is forgotten when the server reappears with a different entry", async () => {
		await connect();
		fingerprint.value = "entry-2";
		const again = await connect();
		expect(again.ms).toBeGreaterThanOrEqual(LOCAL_PROBE_TIMEOUT_MS - 500);
	}, 30_000);
});
