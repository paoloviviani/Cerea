import { describe, expect, it } from "vitest";
import { cookiesToClear, fillLogoutTemplate } from "./oidcLogout";

describe("fillLogoutTemplate", () => {
	it("gives the bundled Authelia's portal logout the page to land on", () => {
		expect(
			fillLogoutTemplate(
				"https://llm.example.org/authelia/logout?rd={redirect}",
				"https://llm.example.org/chat/"
			)
		).toBe("https://llm.example.org/authelia/logout?rd=https%3A%2F%2Fllm.example.org%2Fchat%2F");
	});

	it("uses a template without the placeholder as written", () => {
		expect(fillLogoutTemplate(" https://idp.example.org/logout ", "https://x/")).toBe(
			"https://idp.example.org/logout"
		);
	});
});

describe("cookiesToClear", () => {
	it("reads the console's cookies as the stack names them", () => {
		expect(cookiesToClear("gw_session,gw_idt:/auth")).toEqual([
			{ name: "gw_session", path: "/" },
			{ name: "gw_idt", path: "/auth" },
		]);
	});

	it("is empty when nothing is configured", () => {
		expect(cookiesToClear("")).toEqual([]);
		expect(cookiesToClear(" , ")).toEqual([]);
	});
});
