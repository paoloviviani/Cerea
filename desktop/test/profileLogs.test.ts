import { describe, expect, it } from "vitest";
import { signInState } from "../src/main/galopinInfo.ts";
import { ProfileLogs } from "../src/main/profileLogs.ts";

describe("one log per profile", () => {
	const expired =
		"link: disconnected (getting access token: sign-in to the gateway expired (invalid_grant)); reconnecting in 25s";
	it("keeps the lines apart, so one profile's expired sign-in is not read from another's", () => {
		const logs = new ProfileLogs();
		logs.add("aaaaaaaaaaaa", expired);
		logs.add("bbbbbbbbbbbb", "link: connected");
		logs.add(undefined, "Using the app's own Node");
		expect(signInState(logs.get("aaaaaaaaaaaa"))).toBe("expired");
		expect(signInState(logs.get("bbbbbbbbbbbb"))).toBe("ok");
		expect(signInState(logs.get("cccccccccccc"))).toBe("ok");
		expect(logs.get(undefined)).toEqual(["Using the app's own Node"]);
	});

	it("keeps the newest 500 lines of each", () => {
		const logs = new ProfileLogs();
		for (let i = 0; i < 600; i++) logs.add("aaaaaaaaaaaa", `line ${i}`);
		expect(logs.get("aaaaaaaaaaaa")).toHaveLength(500);
		expect(logs.get("aaaaaaaaaaaa")[0]).toBe("line 100");
		logs.drop("aaaaaaaaaaaa");
		expect(logs.get("aaaaaaaaaaaa")).toEqual([]);
	});
});
