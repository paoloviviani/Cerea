package main

import (
	"os"
	"path/filepath"
)

// opencodeTmpDir is the directory galopin gives opencode as its TMPDIR,
// emptied on every (re)start (see backendopencode.Config.TmpDir for why it
// exists at all: opencode extracts its native libraries there each start and
// never removes them).
//
// It used to live in the state directory, beside the credentials, and that
// was the wrong place: TMPDIR is inherited by every shell the agent starts, so
// any temporary file a command made (a test suite's temp dirs, say) landed in
// galopin's own configuration. It now lives where per-user temporary files
// belong: $XDG_RUNTIME_DIR (per user, 0700, cleared at logout) when that is a
// real directory, else the user cache directory. Never a fixed name under
// /tmp: another user could create it first, as a symlink.
func opencodeTmpDir(stateDir string) string {
	removeLegacyOpencodeTmp(stateDir)
	if runtime := os.Getenv("XDG_RUNTIME_DIR"); filepath.IsAbs(runtime) {
		if info, err := os.Stat(runtime); err == nil && info.IsDir() {
			return filepath.Join(runtime, "galopin", "opencode-tmp")
		}
	}
	if cache, err := os.UserCacheDir(); err == nil && filepath.IsAbs(cache) {
		return filepath.Join(cache, "galopin", "opencode-tmp")
	}
	// No usable per-user location at all: the old place, which at least
	// belongs to this user, rather than a shared one.
	return filepath.Join(stateDir, "opencode-tmp")
}

// removeLegacyOpencodeTmp deletes the TMPDIR an older galopin kept inside its
// state directory. It holds only opencode's extracted libraries and whatever
// commands left behind, all disposable, and galopin empties it on every start
// anyway; leaving it would keep stale files beside the credentials for good.
func removeLegacyOpencodeTmp(stateDir string) {
	if stateDir == "" {
		return
	}
	legacy := filepath.Join(stateDir, "opencode-tmp")
	if info, err := os.Lstat(legacy); err == nil && info.IsDir() {
		_ = os.RemoveAll(legacy)
	}
}
