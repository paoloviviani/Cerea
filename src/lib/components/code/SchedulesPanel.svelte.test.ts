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

	it("shows a zero count the same way", async () => {
		api.listSchedules.mockResolvedValue({
			schedules: [row({ maxOccurrences: 12, firedCount: 0 })],
			limit: 20,
		});
		const screen = renderWithApp(SchedulesPanel);
		await expect.element(screen.getByTestId("run-progress")).toHaveTextContent("0/12 run");
	});

	it("lists only its own area's kind: agent schedules in /code, chat schedules at /schedules", async () => {
		const chat = row({
			id: "c1",
			kind: "chat",
			name: "Weekly news",
			target: { mode: "continue", conversationId: "x", permissionMode: "ask" },
			targetLabel: "Chat › News",
		});
		api.listSchedules.mockResolvedValue({ schedules: [row(), chat], limit: 20 });
		const inCode = renderWithApp(SchedulesPanel);
		await expect.element(inCode.getByText("Nightly check")).toBeVisible();
		expect(inCode.getByText("Weekly news").elements()).toHaveLength(0);
		inCode.unmount();

		const inChat = renderWithApp(SchedulesPanel, { standalone: true });
		await expect.element(inChat.getByText("Weekly news")).toBeVisible();
		expect(inChat.getByText("Nightly check").elements()).toHaveLength(0);
		await expect
			.element(inChat.getByText("Prompts sent to your chats on a timetable."))
			.toBeVisible();
	});
});
