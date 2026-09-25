import { describe, expect, it, beforeEach } from "vitest";
import {
	mintTerminalTicket,
	redeemTerminalTicket,
	_resetTicketStoreForTests,
	_ticketStoreSizeForTests,
} from "./terminalTickets";

const BINDING = {
	userId: "user-1",
	sessionId: "session-1",
	deviceId: "device-1",
	terminalId: "terminal-1",
};

beforeEach(() => {
	_resetTicketStoreForTests();
});

describe("terminal tickets", () => {
	it("redeems once, returning the exact binding it was minted with", () => {
		const ticket = mintTerminalTicket(BINDING);
		expect(redeemTerminalTicket(ticket)).toEqual(BINDING);
	});

	it("is single use: a second redemption of the same ticket fails", () => {
		const ticket = mintTerminalTicket(BINDING);
		expect(redeemTerminalTicket(ticket)).toEqual(BINDING);
		expect(redeemTerminalTicket(ticket)).toBeNull();
	});

	it("expires after 30s", () => {
		const now = Date.now();
		const ticket = mintTerminalTicket(BINDING);
		expect(redeemTerminalTicket(ticket, now + 29_000)).toEqual(BINDING);
	});

	it("refuses a ticket redeemed after its 30s window", () => {
		const now = Date.now();
		const ticket = mintTerminalTicket(BINDING);
		expect(redeemTerminalTicket(ticket, now + 30_001)).toBeNull();
	});

	it("refuses an unknown ticket", () => {
		expect(redeemTerminalTicket("never-minted")).toBeNull();
	});

	it("tracks live tickets, one entry per mint, gone once redeemed", () => {
		const a = mintTerminalTicket(BINDING);
		mintTerminalTicket({ ...BINDING, terminalId: "terminal-2" });
		expect(_ticketStoreSizeForTests()).toBe(2);
		redeemTerminalTicket(a);
		expect(_ticketStoreSizeForTests()).toBe(1);
	});

	it("binds distinct fields for each caller: a mint for one terminal never redeems another's", () => {
		const ticket = mintTerminalTicket(BINDING);
		const binding = redeemTerminalTicket(ticket);
		expect(binding?.terminalId).toBe(BINDING.terminalId);
		expect(binding?.userId).toBe(BINDING.userId);
		expect(binding?.sessionId).toBe(BINDING.sessionId);
		expect(binding?.deviceId).toBe(BINDING.deviceId);
	});
});
