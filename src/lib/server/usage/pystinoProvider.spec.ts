import { describe, expect, it, vi, beforeEach } from "vitest";

const gatewayGetMock: ReturnType<typeof vi.fn> = vi.fn();

vi.mock("$lib/server/gatewayServer", () => ({
	gateway: { get: gatewayGetMock, post: vi.fn(), del: vi.fn() },
}));

const configState = vi.hoisted(() => ({
	usageEnabled: "true",
	baseUrl: "https://gateway.example/v1",
}));

vi.mock("$lib/server/config", () => ({
	config: {
		get CHAT_USAGE_ENABLED() {
			return configState.usageEnabled;
		},
		get OPENAI_BASE_URL() {
			return configState.baseUrl;
		},
	},
}));

const { pystinoUsageProvider } = await import("./pystinoProvider");

/** The shape the fixture array can hold: `current_value` may be either a
 * figure or the unreachable-store null, and ADR 0098's additive
 * `applies_to` (null included — gateway `Optional`s arrive as JSON null)
 * arrives only when the gateway sends it. */
type LimitFixture = {
	id: string;
	name: string;
	scope: "global" | "group" | "user";
	metric: string;
	window_label: string;
	limit_value: string;
	current_value: string | null;
	notification_thresholds: number[];
	applies_to?: "aggregate" | "each_member" | "each_user" | null;
};

/** A rule on this person's own allowance: figures are yours to see. */
const userLimit: LimitFixture = {
	id: "limit-1",
	name: "Monthly tokens",
	scope: "user",
	metric: "tokens",
	window_label: "per month",
	limit_value: "1000.00",
	current_value: "250.00",
	notification_thresholds: [80],
};

/** ADR 0098: the caller's own share of a group budget, not the group's total. */
const memberLimit: LimitFixture = {
	id: "limit-2",
	name: "Team spend",
	scope: "group",
	metric: "spend",
	window_label: "per month",
	limit_value: "50.00",
	current_value: "5.00",
	notification_thresholds: [],
	applies_to: "each_member",
};

/** Pystino 0.14.0: a global rule that caps every person separately — this
 * entry is the caller's own total, so its figures are theirs to see. */
const eachUserLimit: LimitFixture = {
	id: "limit-5",
	name: "Everyone's ceiling",
	scope: "global",
	metric: "spend",
	window_label: "per month",
	limit_value: "20.00",
	current_value: "7.50",
	notification_thresholds: [],
	applies_to: "each_user",
};

/** The group's total — never shown to a member. */
const aggregateLimit: LimitFixture = {
	id: "limit-3",
	name: "Team requests",
	scope: "group",
	metric: "requests",
	window_label: "per day",
	limit_value: "500.00",
	current_value: "470.00",
	notification_thresholds: [],
};

/** The deployment's total — likewise. */
const globalLimit: LimitFixture = {
	id: "limit-4",
	name: "Deployment spend",
	scope: "global",
	metric: "requests",
	window_label: "per day",
	limit_value: "10000.00",
	current_value: "3100.00",
	notification_thresholds: [],
};

/** The single `GET /v1/pystino/usage` document (ADR 0074). */
type Bundle = {
	limits: LimitFixture[];
	usage: typeof usageSummary;
	groups: Record<string, typeof usageSummary> | null;
};
const mockUsage = (bundle: Bundle) =>
	gatewayGetMock.mockImplementation(async (_token: string, path: string) => {
		if (path === "pystino/usage") return bundle;
		throw new Error(`unexpected path ${path}`);
	});

const usageSummary = {
	window_seconds: 86400,
	requests: 42,
	total_tokens: 12345,
	cost: "3.50",
	currency: "USD",
	estimated_requests: 10,
};

/** Distinct figures, so the "never sent" assertions below cannot be fooled by
 * a coincidence with the caller's own numbers. */
const groupUsage = {
	acme: {
		window_seconds: 86400,
		requests: 616,
		total_tokens: 98765,
		cost: "77.77",
		currency: "USD",
		estimated_requests: 2,
	},
};

beforeEach(() => {
	gatewayGetMock.mockReset();
	configState.usageEnabled = "true";
	configState.baseUrl = "https://gateway.example/v1";
});

describe("pystinoUsageProvider.isEnabled", () => {
	it("is enabled with the flag on and a gateway configured", () => {
		expect(pystinoUsageProvider.isEnabled?.({ locals: {} as App.Locals })).toBe(true);
	});

	it("is disabled when the flag is off", () => {
		configState.usageEnabled = "";
		expect(pystinoUsageProvider.isEnabled?.({ locals: {} as App.Locals })).toBe(false);
	});

	it("is disabled with no gateway configured, even with the flag on", () => {
		configState.baseUrl = "";
		expect(pystinoUsageProvider.isEnabled?.({ locals: {} as App.Locals })).toBe(false);
	});
});

describe("pystinoUsageProvider.getReport", () => {
	it("reports needing an OIDC session when locals carry no token", async () => {
		const report = await pystinoUsageProvider.getReport({ locals: {} as App.Locals });

		expect(gatewayGetMock).not.toHaveBeenCalled();
		expect(report.sections).toHaveLength(1);
		expect(report.sections[0].error).toMatch(/OIDC session/);
	});

	it("sends no per-group spend: the document's groups are never mapped out", async () => {
		mockUsage({ limits: [], usage: usageSummary, groups: groupUsage });

		const report = await pystinoUsageProvider.getReport({
			locals: { token: "bearer-token" } as App.Locals,
		});

		const spend = report.sections.find((s) => s.title === "Your spending");
		expect(spend?.entries.map((e) => e.label)).toEqual([
			"You — requests",
			"You — tokens",
			"You — spend",
		]);
		expect(spend?.link).toEqual({ label: "Manage in the Pystino console", href: "/console" });

		// What the browser receives, checked the way it receives it: the
		// provider's report is what `/api/v2/usage` superjson-serializes.
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain("acme");
		expect(serialized).not.toContain("77.77");
		expect(serialized).not.toContain("98765");
		expect(serialized).not.toContain("616");
	});

	it("treats a null groups document (a gateway Optional) as none", async () => {
		mockUsage({ limits: [], usage: usageSummary, groups: null });

		const report = await pystinoUsageProvider.getReport({
			locals: { token: "bearer-token" } as App.Locals,
		});
		const spend = report.sections.find((s) => s.title === "Your spending");
		expect(spend?.entries.map((e) => e.label)).toEqual([
			"You — requests",
			"You — tokens",
			"You — spend",
		]);
	});

	it("lists an aggregate group rule but hides its figures — neither the used amount nor the limit", async () => {
		mockUsage({ limits: [aggregateLimit], usage: usageSummary, groups: {} });

		const report = await pystinoUsageProvider.getReport({
			locals: { token: "bearer-token" } as App.Locals,
		});
		const quotas = report.sections.find((s) => s.title === "Quotas");
		expect(quotas?.entries).toHaveLength(1);
		const entry = quotas?.entries[0];
		// The rule stays visible (ADR 0009: all must pass), saying it exists
		// and for how long — the amounts are the group's, so it still shows
		// nothing numeric. Exact shape on purpose: no figure field survives.
		expect(entry).toEqual({
			label: "Team requests · per day · shared by your group",
			unit: "requests",
			scope: "group",
			noFigures: true,
		});
		expect(entry?.used).toBeUndefined();
		expect(entry?.limit).toBeUndefined();
		expect(entry?.unknown).toBeUndefined();
		expect(JSON.stringify(report)).not.toContain("470");
		expect(JSON.stringify(report)).not.toContain("500.00");
	});

	it("lists a global rule the same way — the used figure is the deployment's total", async () => {
		mockUsage({ limits: [globalLimit], usage: usageSummary, groups: {} });

		const report = await pystinoUsageProvider.getReport({
			locals: { token: "bearer-token" } as App.Locals,
		});
		const quotas = report.sections.find((s) => s.title === "Quotas");
		const entry = quotas?.entries[0];
		expect(entry).toEqual({
			label: "Deployment spend · per day · shared by everyone",
			unit: "requests",
			scope: "global",
			noFigures: true,
		});
		expect(entry?.used).toBeUndefined();
		expect(entry?.limit).toBeUndefined();
		expect(JSON.stringify(report)).not.toContain("3100");
		expect(JSON.stringify(report)).not.toContain("10000.00");
	});

	it("shows a global per-user rule as the caller's own budget, with figures", async () => {
		mockUsage({ limits: [eachUserLimit, globalLimit], usage: usageSummary, groups: groupUsage });

		const report = await pystinoUsageProvider.getReport({
			locals: { token: "bearer-token" } as App.Locals,
		});

		const quotas = report.sections.find((s) => s.title === "Quotas");
		expect(quotas?.entries[0]).toEqual({
			label: "Everyone's ceiling · per month · per person",
			used: 7.5,
			limit: 20,
			unit: "spend",
			scope: "global",
		});
		// The deployment-wide aggregate beside it still shows no figures.
		expect(JSON.stringify(report)).not.toContain("3100");
	});

	it("keeps the caller's own figures: their personal spend, a user rule and a per-member rule", async () => {
		mockUsage({ limits: [userLimit, memberLimit], usage: usageSummary, groups: groupUsage });

		const report = await pystinoUsageProvider.getReport({
			locals: { token: "bearer-token" } as App.Locals,
		});

		const quotas = report.sections.find((s) => s.title === "Quotas");
		expect(quotas?.entries).toEqual([
			{
				label: "Monthly tokens · per month",
				used: 250,
				limit: 1000,
				unit: "tokens",
				scope: "user",
			},
			{
				label: "Team spend · per month · per member",
				used: 5,
				limit: 50,
				unit: "spend",
				scope: "group",
			},
		]);

		const spend = report.sections.find((s) => s.title === "Your spending");
		const yourSpend = spend?.entries.find((e) => e.label === "You — spend");
		expect(yourSpend).toMatchObject({ used: 3.5, unit: "USD", scope: "user" });
		expect(yourSpend?.limit).toBeUndefined();

		// Personal figures, not the group's: 250 and 5 of the caller's own
		// are in; 470 of the group's would only be in if a rule leaked.
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain("470");
		expect(serialized).not.toContain("77.77");
	});

	it("keeps every rule listed, 'all must pass': aggregate rules appear next to kept ones", async () => {
		mockUsage({
			limits: [userLimit, memberLimit, aggregateLimit, globalLimit],
			usage: usageSummary,
			groups: {},
		});

		const report = await pystinoUsageProvider.getReport({
			locals: { token: "bearer-token" } as App.Locals,
		});
		const quotas = report.sections.find((s) => s.title === "Quotas");
		expect(quotas?.entries.map((e) => e.label)).toEqual([
			"Monthly tokens · per month",
			"Team spend · per month · per member",
			"Team requests · per day · shared by your group",
			"Deployment spend · per day · shared by everyone",
		]);
	});

	it("carries a null applies_to (a gateway Optional) as a shared rule, not the caller's own", async () => {
		mockUsage({
			limits: [{ ...aggregateLimit, applies_to: null }],
			usage: usageSummary,
			groups: {},
		});

		const report = await pystinoUsageProvider.getReport({
			locals: { token: "bearer-token" } as App.Locals,
		});
		const quotas = report.sections.find((s) => s.title === "Quotas");
		expect(quotas?.entries[0]).toMatchObject({ noFigures: true });
	});

	it("still reads the caller's own unreadable counter as unknown, never 0%", async () => {
		mockUsage({
			limits: [{ ...memberLimit, current_value: null }],
			usage: usageSummary,
			groups: {},
		});

		const report = await pystinoUsageProvider.getReport({
			locals: { token: "bearer-token" } as App.Locals,
		});
		const quotas = report.sections.find((s) => s.title === "Quotas");
		const entry = quotas?.entries[0];
		expect(entry).toMatchObject({ limit: 50, scope: "group", unknown: true });
		expect(entry?.used).toBe(0);
	});

	it("degrades to an 'unavailable' section instead of throwing when the gateway errors", async () => {
		gatewayGetMock.mockRejectedValue(new Error("gateway is down"));

		const report = await pystinoUsageProvider.getReport({
			locals: { token: "bearer-token" } as App.Locals,
		});

		expect(report.sections).toHaveLength(1);
		expect(report.sections[0].error).toBe("Usage is temporarily unavailable.");
		expect(report.sections[0].entries).toEqual([]);
	});
});
