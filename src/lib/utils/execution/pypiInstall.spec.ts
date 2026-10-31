import { describe, expect, it } from "vitest";
import { pypiInstallEffective } from "./pypiInstall";

describe("pypiInstallEffective", () => {
	it("is on when the user never chose", () => {
		expect(pypiInstallEffective(true, undefined)).toBe(true);
	});
	it("is on when the user chose on and off when they chose off", () => {
		expect(pypiInstallEffective(true, true)).toBe(true);
		expect(pypiInstallEffective(true, false)).toBe(false);
	});
	it("is off whatever the user chose when the administrator switched it off", () => {
		expect(pypiInstallEffective(false, undefined)).toBe(false);
		expect(pypiInstallEffective(false, true)).toBe(false);
		expect(pypiInstallEffective(undefined, true)).toBe(false);
	});
});
