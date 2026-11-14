import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DuplicateKeyError,
	NonFiniteNumberError,
	canonicalBody,
	parseStrictJson,
} from "../src/shared/strictjson.ts";

describe("strict JSON", () => {
	it("parses ordinary JSON, including numbers, nesting and escapes", () => {
		assert.deepEqual(parseStrictJson('{ "a": [1, -2.5, 1e3, true, null, "x\\"y"], "b": {} }'), {
			a: [1, -2.5, 1000, true, null, 'x"y'],
			b: {},
		});
	});
	it("refuses repeated keys at any depth", () => {
		assert.throws(() => parseStrictJson('{"a":1,"a":2}'), DuplicateKeyError);
		assert.throws(() => parseStrictJson('{"x":[{"a":1,"a":2}]}'), DuplicateKeyError);
	});
	it("refuses numbers that are not finite", () => {
		for (const t of ["1e400", "-1e400", "[1e999]", '{"a":{"b":1e309}}']) {
			assert.throws(() => parseStrictJson(t), NonFiniteNumberError, t);
		}
	});
	it("canonicalBody throws on a non-finite value instead of writing null", () => {
		assert.throws(() => canonicalBody({ Memory: Infinity }), NonFiniteNumberError);
		assert.throws(() => canonicalBody({ a: [NaN] }), NonFiniteNumberError);
		assert.equal(canonicalBody({ a: 1 }).toString(), '{"a":1}');
	});
});
