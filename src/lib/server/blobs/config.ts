/**
 * Deployment-only configuration of the blob store (environment variables; no
 * admin screen on purpose: where bytes live is an operator decision).
 */

export type BlobStoreKind = "gridfs" | "s3";

export interface S3Config {
	/** Any S3-compatible URL; undefined is AWS S3. */
	endpoint?: string;
	region: string;
	bucket: string;
	/** Both or neither; neither falls back to the standard AWS credential chain. */
	accessKeyId?: string;
	secretAccessKey?: string;
	forcePathStyle: boolean;
	/** Key prefix with a trailing slash, or "" (for sharing a bucket). */
	prefix: string;
	sse?: "AES256" | "aws:kms";
	kmsKeyId?: string;
	/** Create the bucket at boot when it does not exist (the kit's bundled RustFS). */
	createBucket: boolean;
}

export type BlobConfig = { kind: "gridfs" } | { kind: "s3"; s3: S3Config };

export class BlobConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BlobConfigError";
	}
}

type Getter = (key: string) => string | undefined;

function bool(get: Getter, key: string): boolean | undefined {
	const value = get(key)?.trim().toLowerCase();
	if (!value) return undefined;
	if (["true", "1", "yes"].includes(value)) return true;
	if (["false", "0", "no"].includes(value)) return false;
	throw new BlobConfigError(`${key} must be true or false, not "${get(key)}".`);
}

/** The 3-63 character, lowercase DNS-ish bucket name every S3 implementation accepts. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function readBlobConfig(get: Getter): BlobConfig {
	const kind = (get("CHAT_BLOB_STORE")?.trim().toLowerCase() || "gridfs") as string;
	if (kind === "gridfs") return { kind };
	if (kind !== "s3") {
		throw new BlobConfigError(`CHAT_BLOB_STORE must be "gridfs" or "s3", not "${kind}".`);
	}

	const value = (key: string) => get(key)?.trim() || undefined;

	const endpoint = value("CHAT_S3_ENDPOINT");
	if (endpoint) {
		let url: URL;
		try {
			url = new URL(endpoint);
		} catch {
			throw new BlobConfigError(
				`CHAT_S3_ENDPOINT is not a URL: "${endpoint}" (expected http://host:port or https://host).`
			);
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new BlobConfigError(
				`CHAT_S3_ENDPOINT must be an http or https URL, not "${endpoint}".`
			);
		}
	}

	const region = value("CHAT_S3_REGION") ?? (endpoint ? "us-east-1" : undefined);
	if (!region) {
		throw new BlobConfigError(
			"CHAT_S3_REGION is required with AWS S3 (no CHAT_S3_ENDPOINT), for example eu-west-1."
		);
	}

	const bucket = value("CHAT_S3_BUCKET");
	if (!bucket) throw new BlobConfigError("CHAT_S3_BUCKET is required when CHAT_BLOB_STORE=s3.");
	if (!BUCKET_NAME.test(bucket) || bucket.includes("..")) {
		throw new BlobConfigError(
			`CHAT_S3_BUCKET "${bucket}" is not a valid bucket name (3-63 lowercase letters, digits, dots and hyphens).`
		);
	}

	const accessKeyId = value("CHAT_S3_ACCESS_KEY_ID");
	const secretAccessKey = value("CHAT_S3_SECRET_ACCESS_KEY");
	if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
		throw new BlobConfigError(
			"Set both CHAT_S3_ACCESS_KEY_ID and CHAT_S3_SECRET_ACCESS_KEY, or neither (the standard AWS credential chain is then used)."
		);
	}

	let prefix = value("CHAT_S3_PREFIX") ?? "";
	prefix = prefix.replace(/^\/+/, "");
	if (prefix && !prefix.endsWith("/")) prefix += "/";
	if (prefix.split("/").some((part) => part === "." || part === "..") || prefix.includes("//")) {
		throw new BlobConfigError(
			`CHAT_S3_PREFIX "${prefix}" must not contain empty, "." or ".." parts.`
		);
	}

	const sse = value("CHAT_S3_SSE");
	if (sse !== undefined && sse !== "AES256" && sse !== "aws:kms") {
		throw new BlobConfigError(`CHAT_S3_SSE must be "AES256" or "aws:kms", not "${sse}".`);
	}
	const kmsKeyId = value("CHAT_S3_SSE_KMS_KEY_ID");
	if (kmsKeyId && sse !== "aws:kms") {
		throw new BlobConfigError('CHAT_S3_SSE_KMS_KEY_ID needs CHAT_S3_SSE="aws:kms".');
	}

	return {
		kind: "s3",
		s3: {
			endpoint,
			region,
			bucket,
			accessKeyId,
			secretAccessKey,
			forcePathStyle: bool(get, "CHAT_S3_FORCE_PATH_STYLE") ?? Boolean(endpoint),
			prefix,
			sse: sse as S3Config["sse"],
			kmsKeyId,
			createBucket: bool(get, "CHAT_S3_CREATE_BUCKET") ?? false,
		},
	};
}
