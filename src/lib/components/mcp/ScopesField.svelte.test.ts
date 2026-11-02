import { describe, expect, it } from "vitest";
import { renderWithApp } from "../__tests__/renderWithApp";
import { page } from "@vitest/browser/context";
import ScopesField from "./ScopesField.svelte";

describe("ScopesField", () => {
	it("is a labelled box for scopes, with the sign-out warning", async () => {
		renderWithApp(ScopesField, { value: "a b" });
		const box = page.getByRole("textbox", { name: /Scopes/ });
		await expect.element(box).toHaveValue("a b");
		await expect.element(page.getByText(/signs everybody out/)).toBeVisible();
	});

	it("takes typing, with new lines", async () => {
		renderWithApp(ScopesField, { value: "" });
		const box = page.getByRole("textbox", { name: /Scopes/ });
		await box.fill("one\ntwo");
		await expect.element(box).toHaveValue("one\ntwo");
	});

	it("can be disabled", async () => {
		renderWithApp(ScopesField, { value: "", disabled: true });
		await expect.element(page.getByRole("textbox", { name: /Scopes/ })).toBeDisabled();
	});
});
