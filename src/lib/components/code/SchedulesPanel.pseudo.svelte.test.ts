import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { unbracketedText } from "$lib/components/__tests__/pseudoText";
import { m } from "$lib/paraglide/messages";
import { overwriteGetLocale } from "$lib/paraglide/runtime.js";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import type { ScheduleView } from "$lib/types/Schedule";
import SchedulesPanel from "./SchedulesPanel.svelte";
import ScheduleEditor from "./ScheduleEditor.svelte";
import ScheduleHistory from "./ScheduleHistory.svelte";

const api = vi.hoisted(() => ({
	listSchedules: vi.fn(),
	listScheduleRuns: vi.fn(),
	previewRecurrence: vi.fn(),
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	...api,
}));

const schedule = (over: Partial<ScheduleView> = {}): ScheduleView => ({
	id: "sch1",
	kind: "agent",
	name: "Nightly check",
	target: { deviceId: "d1", workspaceId: "w1", sessionMode: "new", permissionMode: "ask" },
	targetLabel: "Build box › repo › a new session each run",
	prompt: "go",
	recurrence: { type: "weekly", day: 2, at: "09:00" },
	timezone: "UTC",
	enabled: true,
	nextRunAt: new Date("2026-10-12T09:00:00Z"),
	lastStatus: "missed-offline",
	lastRunAt: new Date("2026-10-11T09:00:00Z"),
	maxOccurrences: 5,
	firedCount: 2,
	createdAt: new Date("2026-10-01T00:00:00Z"),
	updatedAt: new Date("2026-10-01T00:00:00Z"),
	...over,
});

// A schedule's own name, target and the person's times are data, not words.
const DATA = [/Nightly check/, /^Build box/, /^UTC$/, /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d+/];

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	codeDeviceList.devices = [] as never;
	codeDeviceList.loading = false;
	api.previewRecurrence.mockResolvedValue({ ok: true, next: [new Date("2026-10-12T09:00:00Z")] });
	overwriteGetLocale(() => "en-XA");
});
afterEach(() => overwriteGetLocale(() => "en"));

describe("Schedules, in the pseudo-locale", () => {
	it("the list owns every word it shows", async () => {
		api.listSchedules.mockResolvedValue({ schedules: [schedule()], limit: 20 });
		const screen = renderWithApp(SchedulesPanel);
		await expect
			.element(screen.getByText(m["code.schedules.title"]({}, { locale: "en-XA" })))
			.toBeVisible();
		await expect.element(screen.getByText(/Nightly check/)).toBeVisible();
		expect(unbracketedText(document.body, DATA)).toEqual([]);
	});

	it("the editor owns every word it shows", async () => {
		const screen = renderWithApp(ScheduleEditor, { onsaved: () => {}, oncancel: () => {} });
		await expect
			.element(screen.getByText(m["code.schedule_editor.title_new"]({}, { locale: "en-XA" })))
			.toBeVisible();
		expect(unbracketedText(document.body, DATA)).toEqual([]);
	});

	it("the history owns every word it shows", async () => {
		api.listScheduleRuns.mockResolvedValue({
			schedule: schedule(),
			runs: [
				{
					id: "r1",
					scheduleId: "sch1",
					firedAt: new Date("2026-10-11T09:00:00Z"),
					status: "missed-offline",
					trigger: "manual",
					detail: "",
				},
			],
		});
		const screen = renderWithApp(ScheduleHistory, { scheduleId: "sch1", onback: () => {} });
		await expect
			.element(screen.getByText(m["code.schedule_history.all_schedules"]({}, { locale: "en-XA" })))
			.toBeVisible();
		await expect
			.element(screen.getByText(m["code.schedule.status.missed_offline"]({}, { locale: "en-XA" })))
			.toBeVisible();
		expect(unbracketedText(document.body, [...DATA, /^\d/, /^Oct/])).toEqual([]);
	});
});
