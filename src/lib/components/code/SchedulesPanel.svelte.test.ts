import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import SchedulesPanel from "./SchedulesPanel.svelte";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import type { ScheduleView } from "$lib/types/Schedule";

const api = vi.hoisted(() => ({
	listSchedules: vi.fn(),
	deleteSchedule: vi.fn(),
	runScheduleNow: vi.fn(),
	updateSchedule: vi.fn(),
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	...api,
}));

const row = (over: Partial<ScheduleView> = {}): ScheduleView => ({
	id: "sch1",
	kind: "agent",
	name: "Nightly check",
	target: { deviceId: "d1", workspaceId: "w1", sessionMode: "new", permissionMode: "ask" },
	targetLabel: "Build box › repo › a new session each run",
	prompt: "go",
	recurrence: { type: "daily", at: "09:00" },
	timezone: "UTC",
	enabled: true,
	nextRunAt: new Date("2026-10-12T09:00:00Z"),
	firedCount: 0,
	createdAt: new Date("2026-10-01T00:00:00Z"),
	updatedAt: new Date("2026-10-01T00:00:00Z"),
	...over,
});

describe("SchedulesPanel list rows", () => {
	beforeEach(() => {
		for (const fn of Object.values(api)) fn.mockReset();
		codeDeviceList.devices = [] as never;
		codeDeviceList.loading = false;
	});

	it("shows the run progress only where a stopping criterion is set", async () => {
		api.listSchedules.mockResolvedValue({
			schedules: [row({ id: "capped", maxOccurrences: 5, firedCount: 3 }), row({ id: "open" })],
			limit: 20,
		});
		const screen = renderWithApp(SchedulesPanel);
		await expect.element(screen.getByTestId("run-progress")).toHaveTextContent("3/5 run");
		// One progress readout: the row without a cap shows nothing.
		expect(screen.getByTestId("run-progress").elements()).toHaveLength(1);
	});

	it("shows the sign-in warning on an enabled schedule while access is expired, and not once it is back", async () => {
		const issue = "Sign in again: the background access stopped working.";
		api.listSchedules.mockResolvedValueOnce({
			schedules: [row({ accessIssue: issue })],
			limit: 20,
		});
		const first = renderWithApp(SchedulesPanel);
		await expect.element(first.getByTestId("access-issue")).toHaveTextContent(issue);
		expect(first.getByTestId("disabled-reason").elements()).toHaveLength(0);
		await first.unmount();

		// After a sign-in the server derives no warning: the same schedule, still enabled, shows none.
		api.listSchedules.mockResolvedValueOnce({
			schedules: [row()],
			limit: 20,
		});
		const second = renderWithApp(SchedulesPanel);
		await expect.element(second.getByText("Nightly check")).toBeInTheDocument();
		expect(second.getByTestId("access-issue").elements()).toHaveLength(0);
	});

	it("shows a zero count the same way", async () => {
		api.listSchedules.mockResolvedValue({
			schedules: [row({ maxOccurrences: 12, firedCount: 0 })],
			limit: 20,
		});
		const screen = renderWithApp(SchedulesPanel);
		await expect.element(screen.getByTestId("run-progress")).toHaveTextContent("0/12 run");
	});

	const chat = row({
		id: "c1",
		kind: "chat",
		name: "Weekly news",
		target: { mode: "continue", conversationId: "x", permissionMode: "ask" },
		targetLabel: "Chat › News",
	});

	function mountAt(
		search: string,
		flags = { chatSchedulesEnabled: true, codeSchedulesEnabled: true }
	) {
		return renderWithApp(SchedulesPanel, undefined, {
			page: { url: new URL(`http://localhost:3000/schedules${search}`), data: flags },
		});
	}

	it("lists both kinds under All, each with its Chat or Agent badge", async () => {
		api.listSchedules.mockResolvedValue({ schedules: [row(), chat], limit: 20 });
		const screen = mountAt("");
		await expect.element(screen.getByText("Nightly check")).toBeVisible();
		await expect.element(screen.getByText("Weekly news")).toBeVisible();
		const badges = screen
			.getByTestId("schedule-kind")
			.elements()
			.map((el) => el.textContent?.trim());
		expect(badges.sort()).toEqual(["Agent", "Chat"]);
		await expect
			.element(screen.getByTestId("schedules-filter-all"))
			.toHaveAttribute("aria-current", "true");
	});

	it("preselects the filter from the address: ?kind=chat lists chats only, ?kind=agent agents only", async () => {
		api.listSchedules.mockResolvedValue({ schedules: [row(), chat], limit: 20 });
		const chats = mountAt("?kind=chat");
		await expect.element(chats.getByText("Weekly news")).toBeVisible();
		expect(chats.getByText("Nightly check").elements()).toHaveLength(0);
		await expect
			.element(chats.getByTestId("schedules-filter-chat"))
			.toHaveAttribute("aria-current", "true");
		chats.unmount();

		const agents = mountAt("?kind=agent");
		await expect.element(agents.getByText("Nightly check")).toBeVisible();
		expect(agents.getByText("Weekly news").elements()).toHaveLength(0);
	});

	it("the filter options are links that change the address", async () => {
		api.listSchedules.mockResolvedValue({ schedules: [row(), chat], limit: 20 });
		const screen = mountAt("?kind=chat");
		await expect.element(screen.getByTestId("schedules-filter")).toBeVisible();
		await expect
			.element(screen.getByTestId("schedules-filter-all"))
			.toHaveAttribute("href", "/schedules");
		await expect
			.element(screen.getByTestId("schedules-filter-agent"))
			.toHaveAttribute("href", "/schedules?kind=agent");
		// New schedule keeps the filter, so it is made as that kind.
		await expect
			.element(screen.getByTestId("new-schedule"))
			.toHaveAttribute("href", "/schedules?kind=chat&new=1");
	});

	it("has no filter, and only that kind, when the deployment offers just one", async () => {
		api.listSchedules.mockResolvedValue({ schedules: [row(), chat], limit: 20 });
		const screen = mountAt("", { chatSchedulesEnabled: true, codeSchedulesEnabled: false });
		await expect.element(screen.getByText("Weekly news")).toBeVisible();
		expect(screen.getByTestId("schedules-filter").elements()).toHaveLength(0);
		expect(screen.getByText("Nightly check").elements()).toHaveLength(0);
	});

	it("feeds the sidebar's attention badge: only failing or blocked schedules count", async () => {
		const { scheduleAttention } = await import("$lib/stores/scheduleAttention.svelte");
		api.listSchedules.mockResolvedValue({
			schedules: [
				row({ id: "ok", lastStatus: "sent" }),
				row({ id: "bad", lastStatus: "failed" }),
				row({ id: "blocked", enabled: false, disabledReason: "Failed three times" }),
				row({ id: "off", enabled: false }),
			],
			limit: 20,
		});
		const screen = mountAt("");
		await expect.element(screen.getByText("Nightly check").first()).toBeVisible();
		expect(scheduleAttention.count).toBe(2);
	});
});
