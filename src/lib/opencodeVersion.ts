/**
 * sha256 of the pinned opencode release archives (`OPENCODE_VERSION` in
 * `codeEnrollCommand.ts`), which the served install script (`galopinDist.ts`,
 * `--with-opencode`) verifies before installing. The source of truth is
 * `agent/packaging/opencode-sha256`; this is the copy the script bakes in, kept
 * equal by `codeEnrollCommand.spec.ts`. Change all of them with
 * `agent/packaging/bump-opencode.sh <version>`.
 */
export const OPENCODE_SHA256: Record<string, string> = {
	"opencode-linux-x64.tar.gz": "13a8fb2978302071b86f9d7e00da9c8895f9cd846978379c3bdc6a5333536c9b",
	"opencode-linux-arm64.tar.gz": "7900818a6a98881edbbadab4b7525940eff3b9750040c200481f9f56cacee405",
	"opencode-darwin-x64.zip": "4e29dbe2f61ace728370523c88027d0742b3a79edcdd2c70e404f616d4ef8f36",
	"opencode-darwin-arm64.zip": "c2d0fecd27acf6e08be02c1f5d384614d07495587766bcc4a6bff3971749bb64",
};
