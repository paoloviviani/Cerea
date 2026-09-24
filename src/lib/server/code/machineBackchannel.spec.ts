import { describe, expect, it } from "vitest";
import { machineBackchannel } from "./machineAuth";

const PUBLIC = "https://llm.example.org/authelia";
const INTERNAL = "http://authelia:9091/authelia";

describe("machineBackchannel", () => {
	it("routes the browser issuer over the internal URL with forwarded headers", () => {
		expect(machineBackchannel(PUBLIC, `${PUBLIC}/`, INTERNAL)).toEqual({
			base: INTERNAL,
			headers: { "x-forwarded-proto": "https", "x-forwarded-host": "llm.example.org" },
		});
	});

	it("keeps a non-default port in the forwarded host", () => {
		const out = machineBackchannel(
			"https://10.0.0.5:18443/authelia",
			"https://10.0.0.5:18443/authelia",
			INTERNAL
		);
		expect(out?.headers["x-forwarded-host"]).toBe("10.0.0.5:18443");
	});

	it("leaves a separately configured machine issuer alone", () => {
		expect(machineBackchannel("http://127.0.0.1:18999", PUBLIC, INTERNAL)).toBeNull();
	});

	it("does nothing without an internal URL", () => {
		expect(machineBackchannel(PUBLIC, PUBLIC, "")).toBeNull();
		expect(machineBackchannel(PUBLIC, PUBLIC, undefined)).toBeNull();
	});
});
