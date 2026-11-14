/**
 * sha256 of the pinned opencode release archives (`OPENCODE_VERSION` in
 * `codeEnrollCommand.ts`), which the served install script (`galopinDist.ts`,
 * `--with-opencode`) verifies before installing. The source of truth is
 * `agent/packaging/opencode-sha256`; this is the copy the script bakes in, kept
 * equal by `codeEnrollCommand.spec.ts`. Change all of them with
 * `agent/packaging/bump-opencode.sh <version>`.
 */
export const OPENCODE_SHA256: Record<string, string> = {
	"opencode-linux-x64.tar.gz": "fc0f81522aceeabac47693d88389efa2bc517ce74c2c38fd6967819fcc6e4d3b",
	"opencode-linux-x64-baseline.tar.gz":
		"fc0f81522aceeabac47693d88389efa2bc517ce74c2c38fd6967819fcc6e4d3b",
	"opencode-linux-x64-musl.tar.gz":
		"dcefa5e90cbd3dc37f7d9741854854021b4b4d495644a6c2bfaf5b0c1634c986",
	"opencode-linux-x64-baseline-musl.tar.gz":
		"dcefa5e90cbd3dc37f7d9741854854021b4b4d495644a6c2bfaf5b0c1634c986",
	"opencode-linux-arm64.tar.gz": "3207fb5cdec448d479242c0f1a14f4f7bdfcad3a79209b5eb8f9003725e93711",
	"opencode-linux-arm64-musl.tar.gz":
		"a0c7a2cbde0f888fe784e31170332f738db1f110509dc3981f5a2760c6323c40",
	"opencode-darwin-x64.zip": "79a4841925e3344d5bb4b000acf6c50b11de301e9047aa9bea9e288e77fe4249",
	"opencode-darwin-x64-baseline.zip":
		"b4985f65e2e4d624ebe5a490df66cbbce06a4146b8ddfab86473f73c2cc57ea2",
	"opencode-darwin-arm64.zip": "7907df2b12720a840fbb49c5b978b9b82925b6bf75479a5fd216afa8932b6702",
};
