/**
 * sha256 of the pinned opencode release archives (`OPENCODE_VERSION` in
 * `codeEnrollCommand.ts`), which the served install script (`galopinDist.ts`,
 * `--with-opencode`) verifies before installing. The source of truth is
 * `agent/packaging/opencode-sha256`; this is the copy the script bakes in, kept
 * equal by `codeEnrollCommand.spec.ts`. Change all of them with
 * `agent/packaging/bump-opencode.sh <version>`.
 */
export const OPENCODE_SHA256: Record<string, string> = {
	"opencode-linux-x64.tar.gz": "9ddd18e3faf64eaeccf6a0fcbc96a5c7a14520ae5fd5b61e5be51d894f478b47",
	"opencode-linux-x64-baseline.tar.gz":
		"9ddd18e3faf64eaeccf6a0fcbc96a5c7a14520ae5fd5b61e5be51d894f478b47",
	"opencode-linux-x64-musl.tar.gz":
		"3d8d0ba66d33e1631ebe61b5539cd2ef971a724ff68eb286554093bf55ba5c9f",
	"opencode-linux-x64-baseline-musl.tar.gz":
		"3d8d0ba66d33e1631ebe61b5539cd2ef971a724ff68eb286554093bf55ba5c9f",
	"opencode-linux-arm64.tar.gz": "cb28cf94541aeb62a4b2ea5997a99b5dd6bae595a772f36fbe279299f2032a4f",
	"opencode-linux-arm64-musl.tar.gz":
		"814d92dc6ce172a382090797df7072b7fe0f2840f2440838228196789c0e352f",
	"opencode-darwin-x64.zip": "a7a4c758a32488138531ab2d82be86e2a1438c35c017664f83daa1d5b63bb82c",
	"opencode-darwin-x64-baseline.zip":
		"3dd6612423b69f7f282866112d99b6d690c8e07f27375b227f6a6ee4e652f5b5",
	"opencode-darwin-arm64.zip": "95a101eda95108478f1db43cff8fcbd4811f6c0e79af1e167301843c6a48d731",
};
