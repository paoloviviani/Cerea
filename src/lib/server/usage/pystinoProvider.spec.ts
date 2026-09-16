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

const limitsPage = {
	data: [
		{
			id: "limit-1",
			name: "Monthly tokens",
			scope: "user" as const,
			metric: "tokens",
			window_label: "per month",
			limit_value: "1000.00",
			current_value: "250.00",
			notification_thresholds: [80],
		},
		{
			id: "limit-2",
			name: "Team requests",
			scope: "group" as const,
			metric: "requests",
			window_label: "per day",
			limit_value: "500.00",
			current_value: null,
			notification_thresholds: [],
		},
	],
};

const usageSummary = {
	window_seconds: 86400,
	requests: 42,
	total_tokens: 12345,
	cost: "3.50",
	currency: "USD",
	estimated_requests: 10,
};

const groupUsage = {
	acme: {
		window_seconds: 86400,
		requests: 7,
		total_tokens: 999,
		cost: "1.20",
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

	it("maps /me/limits into one bar entry per rule, both scopes", async () => {
		gatewayGetMock.mockImplementation(async (_token: string, path: string) => {
			if (path === "me/limits") return limitsPage;
			if (path === "me/usage") return usageSummary;
			if (path === "me/usage/groups") return {};
			throw new Error(`unexpected path ${path}`);
		});

		const report = await pystinoUsageProvider.getReport({
			locals: { token: "bearer-token" } as App.Locals,
		});

		const quotas = report.sections.find((s) => s.title === "Quotas");
		expect(quotas?.entries).toHaveLength(2);

		const [userLimit, groupLimit] = quotas?.entries ?? [];
		expect(userLimit).toMatchObject({ used: 250, limit: 1000, unit: "tokens", scope: "user" });
		expect(userLimit.unknown).toBeFalsy();

		// current_value: null renders as unknown, never a 0% bar.
		expect(groupLimit).toMatchObject({
			limit: 500,
			unit: "requests",
			scope: "group",
			unknown: true,
		});
		expect(groupLimit.used).toBe(0);
	});

	it("keeps quota rules 'all must pass': every rule listed, never a single binding one", async () => {
		gatewayGetMock.mockImplementation(async (_token: string, path: string) => {
			if (path === "me/limits") return limitsPage;
			if (path === "me/usage") return usageSummary;
			if (path === "me/usage/groups") return {};
			throw new Error(`unexpected path ${path}`);
		});

		const report = await pystinoUsageProvider.getReport({
			locals: { token: "bearer-token" } as App.Locals,
		});
		const quotas = report.sections.find((s) => s.title === "Quotas");
		expect(quotas?.entries.map((e) => e.label)).toEqual([
			"Monthly tokens · per month",
			"Team requests · per day",
		]);
	});

	it("maps /me/usage and /me/usage/groups into stat entries plus the console link", async () => {
		gatewayGetMock.mockImplementation(async (_token: string, path: string) => {
			if (path === "me/limits") return { data: [] };
			if (path === "me/usage") return usageSummary;
			if (path === "me/usage/groups") return groupUsage;
			throw new Error(`unexpected path ${path}`);
		});

		const report = await pystinoUsageProvider.getReport({
			locals: { token: "bearer-token" } as App.Locals,
		});

		const spend = report.sections.find((s) => s.title === "Spend");
		expect(spend?.link).toEqual({ label: "Manage in the Pystino console", href: "/console" });

		const spendLabels = spend?.entries.map((e) => e.label);
		expect(spendLabels).toEqual([
			"You — requests",
			"You — tokens",
			"You — spend",
			"acme — requests",
			"acme — tokens",
			"acme — spend",
		]);

		const yourSpend = spend?.entries.find((e) => e.label === "You — spend");
		expect(yourSpend).toMatchObject({ used: 3.5, unit: "USD", scope: "user" });
		expect(yourSpend?.limit).toBeUndefined();
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
