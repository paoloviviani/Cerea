import { afterEach, describe, expect, it } from "vitest";
import { pushPublicKey, vapidKeys } from "./vapid";
import { setVapid, withVapid } from "./testSupport";
import { generateVapidKeys } from "./webpush";

let restore: (() => void) | null = null;
afterEach(() => {
	restore?.();
	restore = null;
});

describe("vapidKeys", () => {
	it("is off when nothing is configured", () => {
		restore = withVapid();
		setVapid("PUBLIC_KEY", "");
		setVapid("PRIVATE_KEY", "");
		expect(vapidKeys()).toBeNull();
		expect(pushPublicKey()).toBeNull();
	});

	it("is on for a matching pair with a mailto or https subject", () => {
		restore = withVapid("mailto:ops@example.org");
		expect(vapidKeys()).not.toBeNull();
		expect(pushPublicKey()).toBe(vapidKeys()?.publicKey);
		setVapid("SUBJECT", "https://chat.example.org");
		expect(vapidKeys()).not.toBeNull();
	});

	it("is off, rather than half working, for a pair that is not a pair", () => {
		restore = withVapid();
		setVapid("PUBLIC_KEY", generateVapidKeys().publicKey);
		expect(vapidKeys()).toBeNull();
	});

	it("is off for garbage keys and for a subject a push service cannot use", () => {
		restore = withVapid();
		setVapid("PRIVATE_KEY", "not-a-key");
		expect(vapidKeys()).toBeNull();
		restore();
		restore = withVapid("ops@example.org");
		expect(vapidKeys()).toBeNull();
	});
});
