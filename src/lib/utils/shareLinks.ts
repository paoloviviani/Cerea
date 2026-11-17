import { base } from "$app/paths";

/** One link as the API lists it (never the token). Mirrors `ShareListing` on the server. */
export interface ShareLink {
	id: string;
	title: string;
	type: string;
	kind: "text" | "file";
	artifactId: string;
	version?: number;
	conversationId: string;
	conversationTitle: string;
	audience: "signed_in" | "anyone";
	expiresAt: string | null;
	status: "active" | "expired" | "revoked";
	views: number;
	createdAt: string;
	updatedAt: string;
	ownerId: string;
	ownerName: string;
}

export type ShareExpiry = 7 | 30 | 90 | null;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${base}${path}`, {
		...init,
		headers: init?.body ? { "Content-Type": "application/json" } : undefined,
	});
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
	}
	return (await res.json()) as T;
}

export const listShares = () =>
	call<{ enabled: boolean; onAppOrigin: boolean; data: ShareLink[] }>("/api/v2/shares");

export const createShare = (body: Record<string, unknown>) =>
	call<{ id: string; url: string; share: ShareLink }>("/api/v2/shares", {
		method: "POST",
		body: JSON.stringify(body),
	});

export const updateShare = (
	id: string,
	body: {
		audience?: ShareLink["audience"];
		expiryDays?: ShareExpiry;
		toLatest?: boolean;
		rotate?: boolean;
	}
) =>
	call<{ share: ShareLink; url?: string }>(`/api/v2/shares/${id}`, {
		method: "PATCH",
		body: JSON.stringify(body),
	});

export const revokeShare = (id: string) =>
	call<{ ok: true }>(`/api/v2/shares/${id}`, { method: "DELETE" });

export const listAdminShares = () =>
	call<{ enabled: boolean; envDefault: boolean; onAppOrigin: boolean; data: ShareLink[] }>(
		"/api/v2/admin/shares"
	);

export const setAdminSharing = (enabled: boolean) =>
	call<{ enabled: boolean }>("/api/v2/admin/shares", {
		method: "PATCH",
		body: JSON.stringify({ enabled }),
	});

export const adminRevokeShare = (id: string) =>
	call<{ ok: true }>(`/api/v2/admin/shares/${id}`, { method: "DELETE" });
