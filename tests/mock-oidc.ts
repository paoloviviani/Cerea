/**
 * Mock OIDC issuer for the machine-agent e2e: discovery, JWKS and a token endpoint that
 * mints RS256 JWT access tokens shaped like the bundled IdP's (`iss`, `aud ∋ pystino-api`,
 * `azp == opencode-enrollment`), so Cerea's local JWT validation runs for real.
 *
 * Control plane (tests only): `POST /__control/mint {sub, expiresIn?, aud?, azp?}` mints an
 * access + refresh token pair; `POST /__control/revoke {refresh_token}` makes that refresh
 * token answer `invalid_grant`, which is how the IdP-side revocation path is exercised.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

export const MOCK_OIDC_PORT = Number(process.env.MOCK_OIDC_PORT ?? 8796);
export const MACHINE_AUDIENCE = "pystino-api";
export const MACHINE_CLIENT_ID = "opencode-enrollment";

interface Grant {
	sub: string;
	aud: string | string[];
	azp: string;
	expiresIn: number;
	revoked: boolean;
}

export interface MintInput {
	sub: string;
	expiresIn?: number;
	aud?: string | string[];
	azp?: string;
}

export interface MockOidc {
	issuer: string;
	port: number;
	mint(input: MintInput): Promise<TokenResponse>;
	close(): Promise<void>;
}

export interface TokenResponse {
	access_token: string;
	refresh_token: string;
	token_type: "Bearer";
	expires_in: number;
}

export async function startMockOidc(port: number = MOCK_OIDC_PORT): Promise<MockOidc> {
	const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
	const kid = randomUUID();
	const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
	const grants = new Map<string, Grant>();
	let issuer = "";

	async function issue(refreshToken: string, grant: Grant): Promise<TokenResponse> {
		const accessToken = await new SignJWT({
			azp: grant.azp,
			client_id: grant.azp,
			scope: "openid offline_access",
		})
			.setProtectedHeader({ alg: "RS256", kid, typ: "at+jwt" })
			.setIssuer(issuer)
			.setSubject(grant.sub)
			.setAudience(grant.aud)
			.setIssuedAt()
			.setJti(randomUUID())
			.setExpirationTime(`${grant.expiresIn}s`)
			.sign(privateKey);
		return {
			access_token: accessToken,
			refresh_token: refreshToken,
			token_type: "Bearer",
			expires_in: grant.expiresIn,
		};
	}

	async function mint(input: MintInput): Promise<TokenResponse> {
		const refreshToken = `rt_${randomUUID()}`;
		const grant: Grant = {
			sub: input.sub,
			aud: input.aud ?? [MACHINE_AUDIENCE],
			azp: input.azp ?? MACHINE_CLIENT_ID,
			expiresIn: input.expiresIn ?? 3600,
			revoked: false,
		};
		grants.set(refreshToken, grant);
		return issue(refreshToken, grant);
	}

	const server = createServer((req, res) => {
		void handle(req, res).catch((err) => {
			if (!res.headersSent) json(res, 500, { error: String(err) });
			else res.end();
		});
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", issuer);
		if (url.pathname === "/.well-known/openid-configuration") {
			json(res, 200, {
				issuer,
				jwks_uri: `${issuer}/jwks`,
				token_endpoint: `${issuer}/token`,
				authorization_endpoint: `${issuer}/authorize`,
				device_authorization_endpoint: `${issuer}/device`,
				userinfo_endpoint: `${issuer}/userinfo`,
				response_types_supported: ["code"],
				subject_types_supported: ["public"],
				id_token_signing_alg_values_supported: ["RS256"],
			});
			return;
		}
		if (url.pathname === "/jwks") {
			json(res, 200, { keys: [jwk] });
			return;
		}
		if (url.pathname === "/token" && req.method === "POST") {
			const form = new URLSearchParams(await readBody(req));
			const refreshToken = form.get("refresh_token") ?? "";
			const grant = grants.get(refreshToken);
			if (form.get("grant_type") !== "refresh_token" || !grant || grant.revoked) {
				json(res, 400, {
					error: "invalid_grant",
					error_description: "The refresh token is expired or was revoked.",
				});
				return;
			}
			json(res, 200, await issue(refreshToken, grant));
			return;
		}
		if (url.pathname === "/__control/mint" && req.method === "POST") {
			json(res, 200, await mint(JSON.parse(await readBody(req)) as MintInput));
			return;
		}
		if (url.pathname === "/__control/revoke" && req.method === "POST") {
			const { refresh_token } = JSON.parse(await readBody(req)) as { refresh_token: string };
			const grant = grants.get(refresh_token);
			if (grant) grant.revoked = true;
			json(res, 200, { revoked: Boolean(grant) });
			return;
		}
		if (url.pathname === "/__control/health") {
			json(res, 200, { ok: true });
			return;
		}
		json(res, 404, { error: "not found" });
	}

	await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
	const actualPort = (server.address() as AddressInfo).port;
	issuer = `http://127.0.0.1:${actualPort}`;
	return {
		issuer,
		port: actualPort,
		mint,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve()))
			),
	};
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	startMockOidc().then((oidc) => {
		console.log(`[mock-oidc] issuer ${oidc.issuer}`);
	});
}
