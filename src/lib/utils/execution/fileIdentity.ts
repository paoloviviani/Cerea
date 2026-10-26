import { EXECUTION_CWD, OUTPUT_ROOT } from "./protocol";

/**
 * Identity of a file a run produced: its name (the path under the sandbox
 * output folder, so `a/x.pdf` and `b/x.pdf` stay two files), its size and
 * the sha256 of its bytes, computed in the browser the moment the sandbox
 * lists it. Every card, registry entry and stored record is keyed by this,
 * never by whether an upload has answered yet.
 */

export interface RunOutputFile {
	/** Sandbox path, valid only while the worker holds the file. */
	path: string;
	size: number;
	/** sha256 of the bytes, lowercase hex. */
	sha256: string;
}

/**
 * The artifact name of a sandbox path: relative to the output folder, so
 * a file in a sub-directory keeps its directory. A path outside it falls back
 * to its bare filename; the old working-directory prefix is still understood,
 * for references stored before the output folder existed.
 */
export function runFileName(path: string): string {
	for (const root of [OUTPUT_ROOT, EXECUTION_CWD]) {
		const prefix = `${root}/`;
		if (path.startsWith(prefix)) return path.slice(prefix.length) || "download";
	}
	// Already a name relative to the working directory (a stored reference).
	if (!path.startsWith("/")) return path || "download";
	const trimmed = path.replace(/^\/+/, "");
	return trimmed.split("/").pop() || "download";
}

/** Last path segment of a name: what a card shows and a download is saved as. */
export function fileBaseName(name: string): string {
	return name.split("/").pop() || name || "download";
}

/** Directory part of a name, or "" for a file at the top. */
export function fileDirName(name: string): string {
	const i = name.lastIndexOf("/");
	return i > 0 ? name.slice(0, i) : "";
}

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * sha256 in plain JavaScript, for pages where SubtleCrypto does not exist: a
 * self-hosted Cerea opened over http on a LAN address is not a secure
 * context, and there `crypto.subtle` is undefined.
 */
export function sha256HexSync(bytes: Uint8Array): string {
	const h = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	]);
	const length = bytes.byteLength;
	const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
	padded.set(bytes);
	padded[length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
	view.setUint32(padded.length - 4, (length << 3) >>> 0);
	const w = new Uint32Array(64);
	const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
	for (let off = 0; off < padded.length; off += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
		}
		let [a, b, c, d, e, f, g, hh] = h;
		for (let i = 0; i < 64; i++) {
			const t1 =
				(hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
			const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
			hh = g;
			g = f;
			f = e;
			e = (d + t1) | 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) | 0;
		}
		h[0] += a;
		h[1] += b;
		h[2] += c;
		h[3] += d;
		h[4] += e;
		h[5] += f;
		h[6] += g;
		h[7] += hh;
	}
	return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	const subtle = typeof crypto === "undefined" ? undefined : crypto.subtle;
	if (!subtle) return sha256HexSync(bytes);
	const digest = await subtle.digest(
		"SHA-256",
		bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
	);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Bytes of the files this tab produced, by sha256, kept for a bounded total.
 * They are what lets a file be downloaded, previewed and uploaded again when
 * the store does not hold it yet (an upload in flight or failed), without
 * trusting the sandbox filesystem to still hold the same bytes later. Oldest
 * entries go first; a file bigger than the whole budget is never kept.
 */
const CACHE_BUDGET_BYTES = 32 * 1024 * 1024;
const cache = new Map<string, Uint8Array>();
let cached = 0;

export function cacheFileBytes(sha256: string, bytes: Uint8Array): void {
	if (bytes.byteLength > CACHE_BUDGET_BYTES) return;
	const previous = cache.get(sha256);
	if (previous) {
		cached -= previous.byteLength;
		cache.delete(sha256);
	}
	cache.set(sha256, bytes);
	cached += bytes.byteLength;
	for (const [key, value] of cache) {
		if (cached <= CACHE_BUDGET_BYTES) break;
		if (key === sha256) continue;
		cache.delete(key);
		cached -= value.byteLength;
	}
}

export function cachedFileBytes(sha256: string): Uint8Array | undefined {
	return cache.get(sha256);
}

/** Empties the cache; tests only. */
export function clearFileByteCache(): void {
	cache.clear();
	cached = 0;
}
