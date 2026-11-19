/**
 * The Mistral Vibe release galopin supports as an engine and the sha256 of its
 * dependency lock (every package pinned by hash, for Linux and macOS on amd64 and
 * arm64). The source of truth is `agent/packaging/vibe-version` and
 * `agent/packaging/vibe-requirements.txt`; this is the copy the served install
 * script (`galopinDist.ts`) bakes in, kept equal by `vibeVersion.spec.ts`. Change
 * all three with `agent/packaging/bump-vibe.sh <version>`.
 */
export const VIBE_VERSION = "3.1.3";

/** sha256 (hex) of `vibe-requirements.txt`, which galopin's dist serves. */
export const VIBE_LOCK_SHA256 = "80081705d903c399b40c2186ac9814e65a345e3f1019b0140f629c1696e65c36";
