import { describe, expect, it } from "vitest";
import { BlobConfigError, readBlobConfig } from "./config";

const get = (env: Record<string, string>) => (key: string) => env[key];
const S3 = { CHAT_BLOB_STORE: "s3", CHAT_S3_BUCKET: "cerea-files" };

describe("readBlobConfig", () => {
	it("defaults to GridFS, and treats an empty value as unset (the kit passes empty strings)", () => {
		expect(readBlobConfig(get({}))).toEqual({ kind: "gridfs" });
		expect(readBlobConfig(get({ CHAT_BLOB_STORE: "" }))).toEqual({ kind: "gridfs" });
		expect(readBlobConfig(get({ CHAT_BLOB_STORE: "GridFS" }))).toEqual({ kind: "gridfs" });
	});

	it("refuses a backend it does not know", () => {
		expect(() => readBlobConfig(get({ CHAT_BLOB_STORE: "azure" }))).toThrow(/gridfs.*s3/);
	});

	it("reads an S3-compatible endpoint with path-style on by default", () => {
		const config = readBlobConfig(
			get({
				...S3,
				CHAT_S3_ENDPOINT: "http://rustfs:9000",
				CHAT_S3_ACCESS_KEY_ID: "k",
				CHAT_S3_SECRET_ACCESS_KEY: "s",
			})
		);
		expect(config).toMatchObject({
			kind: "s3",
			s3: {
				endpoint: "http://rustfs:9000",
				region: "us-east-1",
				bucket: "cerea-files",
				forcePathStyle: true,
				prefix: "",
				createBucket: false,
			},
		});
	});

	it("on AWS (no endpoint) needs a region, defaults to virtual-hosted style and the credential chain", () => {
		expect(() => readBlobConfig(get(S3))).toThrow(/CHAT_S3_REGION/);
		const config = readBlobConfig(get({ ...S3, CHAT_S3_REGION: "eu-west-1" }));
		expect(config).toMatchObject({
			s3: { endpoint: undefined, forcePathStyle: false, accessKeyId: undefined },
		});
	});

	it("lets path-style be overridden either way", () => {
		expect(
			readBlobConfig(
				get({ ...S3, CHAT_S3_ENDPOINT: "https://x.example", CHAT_S3_FORCE_PATH_STYLE: "false" })
			)
		).toMatchObject({ s3: { forcePathStyle: false } });
		expect(
			readBlobConfig(get({ ...S3, CHAT_S3_REGION: "eu-west-1", CHAT_S3_FORCE_PATH_STYLE: "true" }))
		).toMatchObject({ s3: { forcePathStyle: true } });
		expect(() =>
			readBlobConfig(
				get({ ...S3, CHAT_S3_ENDPOINT: "https://x.example", CHAT_S3_FORCE_PATH_STYLE: "maybe" })
			)
		).toThrow(/true or false/);
	});

	it("names the setting that is wrong", () => {
		const ok = { ...S3, CHAT_S3_ENDPOINT: "http://s3:9000" };
		expect(() =>
			readBlobConfig(get({ CHAT_BLOB_STORE: "s3", CHAT_S3_ENDPOINT: "http://s3" }))
		).toThrow(/CHAT_S3_BUCKET/);
		expect(() => readBlobConfig(get({ ...ok, CHAT_S3_BUCKET: "Bad_Name" }))).toThrow(/bucket name/);
		expect(() => readBlobConfig(get({ ...ok, CHAT_S3_ENDPOINT: "rustfs:9000" }))).toThrow(
			/CHAT_S3_ENDPOINT/
		);
		expect(() => readBlobConfig(get({ ...ok, CHAT_S3_ENDPOINT: "ftp://x" }))).toThrow(
			/http or https/
		);
		expect(() => readBlobConfig(get({ ...ok, CHAT_S3_ACCESS_KEY_ID: "k" }))).toThrow(/both/i);
		expect(() => readBlobConfig(get({ ...ok, CHAT_S3_SSE: "rot13" }))).toThrow(/CHAT_S3_SSE/);
		expect(() => readBlobConfig(get({ ...ok, CHAT_S3_SSE_KMS_KEY_ID: "k" }))).toThrow(/aws:kms/);
		expect(() => readBlobConfig(get({ ...ok, CHAT_S3_PREFIX: "a/../b" }))).toThrow(
			/CHAT_S3_PREFIX/
		);
		expect(() => readBlobConfig(get({ ...ok, CHAT_S3_PREFIX: "a/../b" }))).toThrow(BlobConfigError);
	});

	it("normalises the prefix to one trailing slash and no leading one", () => {
		const env = { ...S3, CHAT_S3_ENDPOINT: "http://s3:9000" };
		const prefix = (p: string) =>
			(readBlobConfig(get({ ...env, CHAT_S3_PREFIX: p })) as { s3: { prefix: string } }).s3.prefix;
		expect(prefix("cerea")).toBe("cerea/");
		expect(prefix("/team/cerea/")).toBe("team/cerea/");
		expect(prefix("")).toBe("");
	});

	it("takes server-side encryption with an optional KMS key", () => {
		expect(
			readBlobConfig(
				get({
					...S3,
					CHAT_S3_REGION: "eu-west-1",
					CHAT_S3_SSE: "aws:kms",
					CHAT_S3_SSE_KMS_KEY_ID: "alias/x",
				})
			)
		).toMatchObject({ s3: { sse: "aws:kms", kmsKeyId: "alias/x" } });
	});
});
