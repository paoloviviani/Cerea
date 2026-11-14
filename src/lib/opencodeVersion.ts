/**
 * sha256 of the pinned opencode release archives (`OPENCODE_VERSION` in
 * `codeEnrollCommand.ts`), which the served install script (`galopinDist.ts`,
 * `--with-opencode`) verifies before installing. The source of truth is
 * `agent/packaging/opencode-sha256`; this is the copy the script bakes in, kept
 * equal by `codeEnrollCommand.spec.ts`. Change all of them with
 * `agent/packaging/bump-opencode.sh <version>`.
 */
export const OPENCODE_SHA256: Record<string, string> = {
	"opencode-linux-x64.tar.gz": "89a6cee227b54bc011179c528a5e63176032462b1a5e21723b616801cddc2ca7",
	"opencode-linux-x64-baseline.tar.gz": "89a6cee227b54bc011179c528a5e63176032462b1a5e21723b616801cddc2ca7",
	"opencode-linux-x64-musl.tar.gz": "c1801a36bf61e03eafac8d7f4521a200e4d3cd76cf43b36621cb78b460b851ee",
	"opencode-linux-x64-baseline-musl.tar.gz": "c1801a36bf61e03eafac8d7f4521a200e4d3cd76cf43b36621cb78b460b851ee",
	"opencode-linux-arm64.tar.gz": "c1682057f0815cb2abdd6e00305f1146ebaf1c167f0335cdb74ddc80008120e7",
	"opencode-linux-arm64-musl.tar.gz": "a03405f94ae02db7acb0870cf32030bab86460dc7faf524780e9cae305526b96",
	"opencode-darwin-x64.zip": "3e4ea96ece041218cc74bc7c7d5cd202ff1f7983e32fc7ab6c58d532445e7961",
	"opencode-darwin-x64-baseline.zip": "7830c9ce3945ad9fee792f603d4c9abcbb041b5cabafb51ce3c40da1dad5b435",
	"opencode-darwin-arm64.zip": "811c42be9cad489ea8c411ead49e06f691deee4957ba9a0a56a159a7d6c1abdc",
};
