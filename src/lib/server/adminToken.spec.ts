import { beforeEach, describe, expect, it, vi } from "vitest";

const config: Record<string, string | undefined> = {};
vi.mock("$lib/server/config", () => ({ config }));
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock("./logger", () => ({ logger }));

const { adminTokenManager } = await import("./adminToken");

beforeEach(() => {
	for (const k of Object.keys(config)) delete config[k];
	logger.info.mockClear();
});

describe("adminTokenManager", () => {
	it("is off by default", () => {
		expect(adminTokenManager.enabled).toBe(false);
	});

	it("is on when the flag is true and no OpenID is configured", () => {
		config.ADMIN_CLI_LOGIN = "true";
		expect(adminTokenManager.enabled).toBe(true);
	});

	it("is off when OpenID is configured, even if the flag is true", () => {
		config.ADMIN_CLI_LOGIN = "true";
		config.OPENID_CLIENT_ID = "abc";
		expect(adminTokenManager.enabled).toBe(false);
		config.OPENID_CLIENT_ID = "";
		config.OPENID_CONFIG = '{"CLIENT_ID":"abc"}';
		expect(adminTokenManager.enabled).toBe(false);
	});

	it("logs no token when disabled", () => {
		config.ADMIN_CLI_LOGIN = "true";
		config.OPENID_CLIENT_ID = "abc";
		adminTokenManager.displayToken();
		expect(logger.info).not.toHaveBeenCalled();
	});

	it("logs the login URL only when enabled", () => {
		config.ADMIN_CLI_LOGIN = "true";
		adminTokenManager.displayToken();
		expect(logger.info).toHaveBeenCalledTimes(1);
	});

	it("validate-token refuses when disabled", async () => {
		config.ADMIN_CLI_LOGIN = "true";
		config.OPENID_CLIENT_ID = "abc";
		const { POST } = await import("../../routes/api/user/validate-token/+server");
		// Read the live token by enabling briefly and capturing the logged URL.
		delete config.OPENID_CLIENT_ID;
		adminTokenManager.displayToken();
		const token = String(logger.info.mock.calls[0][0]).split("token=")[1];
		config.OPENID_CLIENT_ID = "abc";
		const res = await POST({
			request: new Request("http://x", { method: "POST", body: JSON.stringify({ token }) }),
			locals: { sessionId: "s1" },
		} as never);
		expect(await res.json()).toEqual({ valid: false });
		expect(adminTokenManager.isAdmin("s1")).toBe(false);
	});
});
