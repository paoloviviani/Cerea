import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { snapshotSchema } from "../src/contract.ts";
import { rig, type Rig } from "./helpers.ts";

describe("snapshot", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	it("lists controls with refs and the metadata a classifier needs", async () => {
		const snap = await r.goto("/form");
		snapshotSchema.parse(snap);
		const name = r.element(snap, r.ref(snap, "textbox", "Full name"));
		assert.equal(name.inputType, "text");
		assert.match(name.form ?? "", /form/);
		assert.equal(name.formMethod, "post", "a field carries the method of its form");
		assert.equal(name.submits, undefined);
		const email = r.element(snap, r.ref(snap, "textbox", "Email"));
		assert.equal(email.inputType, "email");
		const save = r.element(snap, r.ref(snap, "button", "Save"));
		assert.equal(save.submits, true);
		assert.equal(save.formMethod, "post");
		assert.equal(save.form, name.form);
		assert.ok(snap.text.includes("[" + save.ref + '] button "Save" (submits form)'), snap.text);
		const role = snap.text.split("\n").find((l) => l.includes("combobox"));
		assert.match(role ?? "", /options: "--" \| "Designer" \| "Engineer"/);
	});

	it("fences the page as untrusted content and reports url and title", async () => {
		const snap = await r.goto("/form");
		const lines = snap.text.split("\n");
		assert.equal(lines[0], '<page-content untrusted="true">');
		assert.equal(lines.at(-1), "</page-content>");
		assert.ok(lines.includes(`url: ${r.fx.base}/form`));
		assert.ok(lines.includes('title: "Contact form"'));
		assert.equal(snap.title, "Contact form");
		assert.equal(snap.url, `${r.fx.base}/form`);
	});

	it("marks a GET form's submit as get, and never reports a password value", async () => {
		const search = await r.goto("/search");
		const button = r.element(search, r.ref(search, "button", "Search"));
		assert.equal(button.submits, true);
		assert.equal(button.formMethod, "get");
		const login = await r.goto("/login");
		const pass = r.element(login, r.ref(login, "textbox", "Password"));
		assert.equal(pass.inputType, "password");
		await r.act([{ type: "fill", ref: pass.ref, text: "s3cret-pass" }]);
		const after = await r.snapshot();
		assert.equal(r.element(after, pass.ref).value, undefined);
		assert.ok(!after.text.includes("s3cret-pass"));
	});

	it("gives a link's target and the other domain when it leaves the site", async () => {
		const snap = await r.goto("/outbound");
		const partner = r.element(snap, r.ref(snap, "link", "Partner site"));
		assert.equal(partner.linkDomain, "localhost");
		assert.match(partner.href ?? "", /^http:\/\/localhost:\d+\/form$/);
		const contact = r.element(snap, r.ref(snap, "link", "Contact us"));
		assert.equal(contact.linkDomain, undefined);
		assert.equal(contact.href, "/form");
		assert.ok(snap.text.includes("(other site: localhost)"));
	});

	it("flags downloads: the download attribute and file-type targets", async () => {
		const snap = await r.goto("/downloads");
		assert.equal(r.element(snap, r.ref(snap, "link", "Report (CSV)")).download, true);
		assert.equal(r.element(snap, r.ref(snap, "link", "Plain file link")).download, true);
	});

	it("collapses a long table and points at extract", async () => {
		const snap = await r.goto("/table");
		assert.ok(snap.collapsed && snap.collapsed >= 190, `collapsed ${snap.collapsed}`);
		assert.match(snap.text, /and 197 more rows like this; use extract/);
		assert.match(snap.text, /header: ID \| Name \| Dept \| Salary/);
		assert.match(snap.text, /row: 1 \| Person 1 \| Ops \| 40000/);
		assert.ok(snap.text.length < 1500, `snapshot is ${snap.text.length} characters`);
	});

	it("keeps more rows when they hold controls, and folds the rest", async () => {
		const snap = await r.goto("/table-links");
		const links = snap.elements.filter((e) => e.role === "link");
		assert.equal(links.length, 10);
		assert.match(snap.text, /and 20 more rows like this/);
	});

	it("folds long lists into one line", async () => {
		const snap = await r.goto("/lists");
		assert.match(snap.text, /and 9 more items like this; use extract/);
		assert.match(snap.text, /text "Task 1"/);
	});

	it("caps its size with a hint, and scrolling brings the cut part back", async () => {
		await r.session.close();
		const small = await rig({ maxSnapshotChars: 3000 });
		try {
			const first = await small.goto("/long");
			assert.ok(first.text.length <= 3200, `${first.text.length} characters`);
			assert.match(first.text, /truncated: \d+ more lines below \(scroll down/);
			await small.act([{ type: "scroll", direction: "down", amount: 12 }]);
			const later = await small.snapshot();
			assert.match(later.text, /lines above the viewport \(scroll up/);
			assert.ok(!later.text.includes("Paragraph 1:"), "the top of the page was cut");
			const nums = [...later.text.matchAll(/Paragraph (\d+):/g)].map((m) => Number(m[1]));
			assert.ok(nums.length > 0 && nums[0] > 5, `paragraphs ${nums}`);
		} finally {
			await small.close();
		}
	});
});
