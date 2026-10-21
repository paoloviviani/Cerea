import { describe, expect, it } from "vitest";
import { MONGOD_VERSION, MONGOD_VERSION_NO_AVX, mongoMemoryVersion } from "./mongoMemoryVersion";

describe("mongoMemoryVersion", () => {
	it("uses 4.4 when the CPU has no AVX", () => {
		const cpuinfo = "processor\t: 0\nflags\t\t: fpu sse sse2 ssse3 sse4_2 aes\n";
		expect(mongoMemoryVersion(cpuinfo)).toBe(MONGOD_VERSION_NO_AVX);
	});

	it("keeps the current version when the CPU has AVX", () => {
		const cpuinfo = "processor\t: 0\nflags\t\t: fpu sse sse4_2 avx avx2 aes\n";
		expect(mongoMemoryVersion(cpuinfo)).toBe(MONGOD_VERSION);
	});

	it("does not mistake avx2-only or avx512 flag names for avx", () => {
		expect(mongoMemoryVersion("flags\t: fpu avx2\n")).toBe(MONGOD_VERSION_NO_AVX);
	});
});
