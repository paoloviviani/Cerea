/**
 * The gateway's self-service key endpoints, as a scheduled chat run uses them:
 * `POST /v1/me/keys` mints a key as the signed-in person, `DELETE /v1/me/keys/{id}`
 * revokes one. Both authenticate with a bearer: the person's own session token to
 * mint (the only time a chat schedule has one), and either that token or the key
 * itself to revoke.
 *
 * A key is a person's own: it carries their quota, model access, redaction rule and
 * billing, and shows in their key list in the gateway's console under the name given
 * here. The secret is in the mint response and nowhere else.
 */

import { config } from "$lib/server/config";
import { CredentialError } from "./executors";

export interface MintedKey {
	id: string;
	secret: string;
}

export interface KeyCallOptions {
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

function base(options: KeyCallOptions): string {
	return (options.baseUrl ?? config.OPENAI_BASE_URL ?? "").replace(/\/$/, "");
}

async function messageOf(response: Response, fallback: string): Promise<string> {
	try {
		const body = (await response.json()) as {
			error?: { message?: unknown };
			detail?: unknown;
			message?: unknown;
		};
		for (const candidate of [body?.error?.message, body?.detail, body?.message]) {
			if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
		}
	} catch {
		// The status is the answer; the body only makes a nicer message.
	}
	return fallback;
}

export async function mintKey(
	input: { token: string; name: string; billingGroupId?: string },
	options: KeyCallOptions = {}
): Promise<MintedKey> {
	const url = base(options);
	if (!url)
		throw new CredentialError(400, "Scheduled chats need the gateway, which is not set up here.");
	let response: Response;
	try {
		response = await (options.fetchImpl ?? fetch)(`${url}/me/keys`, {
			method: "POST",
			headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
			body: JSON.stringify({
				name: input.name.slice(0, 120),
				...(input.billingGroupId ? { billing_group_id: input.billingGroupId } : {}),
			}),
			signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
		});
	} catch {
		throw new CredentialError(
			502,
			"The gateway did not answer, so the schedule's key could not be made. Try again."
		);
	}
	if (response.status === 401) {
		throw new CredentialError(403, "Sign in again, then save the schedule.");
	}
	if (response.status === 403) {
		throw new CredentialError(
			403,
			await messageOf(response, "Your account may not create the key a scheduled chat needs.")
		);
	}
	if (response.status === 400 || response.status === 422) {
		throw new CredentialError(
			400,
			await messageOf(response, "The gateway refused to make the schedule's key.")
		);
	}
	if (!response.ok) {
		throw new CredentialError(502, "The gateway could not make the schedule's key. Try again.");
	}
	const body = (await response.json().catch(() => null)) as {
		id?: unknown;
		secret?: unknown;
	} | null;
	if (typeof body?.id !== "string" || typeof body.secret !== "string" || !body.secret) {
		throw new CredentialError(502, "The gateway answered without a key. Try again.");
	}
	return { id: body.id, secret: body.secret };
}

/** Revoke a key. Resolves true when it is gone (or was never there), false when the gateway could not say. */
export async function revokeKey(
	input: { token: string; keyId: string },
	options: KeyCallOptions = {}
): Promise<boolean> {
	const url = base(options);
	if (!url) return false;
	try {
		const response = await (options.fetchImpl ?? fetch)(
			`${url}/me/keys/${encodeURIComponent(input.keyId)}`,
			{
				method: "DELETE",
				headers: { authorization: `Bearer ${input.token}` },
				signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
			}
		);
		return response.ok || response.status === 404;
	} catch {
		return false;
	}
}
