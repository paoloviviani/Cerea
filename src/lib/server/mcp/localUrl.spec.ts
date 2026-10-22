import { describe, expect, it } from "vitest";
import {
	isLocalConnectorId,
	isLocalServerUrl,
	localConnectorId,
	localServerUrl,
	parseLocalConnectorId,
	parseLocalServerUrl,
	withoutLocalUrls,
} from "./localUrl";

const DEVICE = "0123456789abcdef01234567";
const USER = "76543210fedcba9876543210";

describe("local connector ids and addresses (ADR 0102)", () => {
	it("round-trips an id, which cannot collide with a configured connector's 24-hex id", () => {
		const id = localConnectorId(DEVICE, "notes");
		expect(id).toBe(`local:${DEVICE}:notes`);
		expect(parseLocalConnectorId(id)).toEqual({ deviceId: DEVICE, server: "notes" });
		expect(isLocalConnectorId(id)).toBe(true);
		expect(isLocalConnectorId(DEVICE)).toBe(false);
	});

	it("refuses an id with a malformed device or a server name mcp.json would not allow", () => {
		for (const bad of [
			"local:xyz:notes",
			`local:${DEVICE}:`,
			`local:${DEVICE}:has space`,
			`local:${DEVICE}:../x`,
			`local:${DEVICE}:${"a".repeat(65)}`,
			DEVICE,
		]) {
			expect(parseLocalConnectorId(bad), bad).toBeNull();
		}
	});

	it("round-trips an address, which names the person, the device and the server", () => {
		const url = localServerUrl(USER, DEVICE, "my-notes_2");
		expect(parseLocalServerUrl(url)).toEqual({
			userId: USER,
			deviceId: DEVICE,
			server: "my-notes_2",
		});
		// Two people's pool keys differ even for a device id they somehow shared.
		expect(localServerUrl("a".repeat(24), DEVICE, "n")).not.toBe(localServerUrl(USER, DEVICE, "n"));
	});

	it("refuses addresses that are not exactly that shape", () => {
		for (const bad of [
			"https://example.com/mcp",
			`machine://${DEVICE}/notes`,
			`machine://${DEVICE}/notes?user=nope`,
			`machine://nope/notes?user=${USER}`,
			`machine://${DEVICE}/a%20b?user=${USER}`,
			"machine:",
			"not a url",
		]) {
			expect(parseLocalServerUrl(bad), bad).toBeNull();
		}
	});

	it("recognises the scheme in any case, so a browser cannot slip one past the filter", () => {
		expect(isLocalServerUrl(localServerUrl(USER, DEVICE, "n"))).toBe(true);
		expect(isLocalServerUrl("MACHINE://x")).toBe(true);
		expect(isLocalServerUrl("https://machine.example.com")).toBe(false);
		expect(
			withoutLocalUrls([
				{ url: "Machine://x" },
				{ url: "https://ok.example.com" },
				{ url: "machine:foo" },
			])
		).toEqual([{ url: "https://ok.example.com" }]);
	});
});
