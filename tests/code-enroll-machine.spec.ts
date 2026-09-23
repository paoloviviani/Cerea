/**
 * The machine pairing endpoint is a *program* surface: `enroll pair` on the
 * agent machine POSTs the pairing offer with a bearer, no browser involved.
 *
 * What makes that possible is the hook treating the route as a machine
 * endpoint (MACHINE_CODE_ROUTES): without it, a bearer on an /api path is
 * presented to huggingface.co and dies there, and a POST without a session
 * hits the signed-in wall. These specs pin the observable result — both
 * requests reach the endpoint and get its own 401 — over the hermetic part
 * of the surface only: an actual *valid* token would drag the dev server
 * into an issuer round trip, and the e2e stack has no IdP to answer it. The
 * authenticated paths (userinfo claims → user row → probe → upsert) are unit
 * tested in `src/routes/api/v2/code/enroll/machine/machine.spec.ts` with the
 * userinfo call mocked.
 */
import { test, expect } from "./fixtures";
import { E2E_APP_URL } from "./fixtures";

const ENDPOINT = `${E2E_APP_URL}/api/v2/code/enroll/machine`;

test("a machine POST without a bearer reaches the endpoint's 401, not the wall's", async ({
	request,
}) => {
	const res = await request.post(ENDPOINT, {
		headers: { "content-type": "application/json" },
		data: { name: "box", offer: "https://app.paseo.sh/#offer=x" },
	});
	expect(res.status()).toBe(401);
	// The endpoint's words, not the login wall's ("You must be logged in")
	// and not authenticateRequest's ("Must have a valid session or user").
	const body = await res.json();
	expect(body.message).toContain("Bearer");
});

test("a bearer the endpoint must validate never reaches the generic HF-token path", async ({
	request,
}) => {
	// authenticateRequest's bearer branch presents tokens to huggingface.co;
	// this route is exempt from it, so a foreign-issuer bearer survives to
	// the endpoint, whose own userinfo attempt fails against the e2e stack's
	// deliberately unreachable OPENID_PROVIDER_URL — answered as the endpoint's
	// 401, not the hook's thrown 500.
	const res = await request.post(ENDPOINT, {
		headers: { "content-type": "application/json", authorization: "Bearer garbage" },
		data: { name: "box", offer: "https://app.paseo.sh/#offer=x" },
	});
	expect(res.status()).toBe(401);
	const body = await res.json();
	expect(body.message).toContain("not valid or has expired");
});
