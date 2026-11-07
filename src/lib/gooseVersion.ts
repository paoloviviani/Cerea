/**
 * The goose release galopin supports as an engine (ADR 0110) and the sha256 of
 * its official release archives (upstream publishes none, so they are recorded
 * here). The source of truth is `agent/packaging/goose-version` and
 * `agent/packaging/goose-sha256`; this is the copy the served install script
 * (`galopinDist.ts`) bakes in, kept equal by `gooseVersion.spec.ts`. Change all
 * three with `agent/packaging/bump-goose.sh <version>`.
 */
export const GOOSE_VERSION = "1.57.0";

/** Archive name -> sha256 (hex). */
export const GOOSE_SHA256: Record<string, string> = {
	"goose-aarch64-apple-darwin.tar.gz":
		"80d43c49b77302777e9d2fe32faf3c40c1028dafbea1e0a39b0378404a8a074b",
	"goose-aarch64-unknown-linux-gnu.tar.gz":
		"c32605acfd560aeb2adbf17ec359cc0217e28022a7e647b35a6af5dcfca91749",
	"goose-x86_64-apple-darwin.tar.gz":
		"5ad5594246841c759b34966e09ca421c09151b589183a8f1720e15e8395834ae",
	"goose-x86_64-unknown-linux-gnu.tar.gz":
		"10eb96cb6a159b6e1d38eeedbef6ab64cd28168aad91948f1fa5c34eefdf98e3",
};
