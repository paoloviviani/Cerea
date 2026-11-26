package decide

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// A committed .env file is not a local secret (owner's decision): the .env
// guards (the secret-value guard, the read tool's `*.env` card, a command that
// names an env file) skip a .env file git tracks whose working-tree content is
// exactly the committed blob. A tracked file someone edited may hold real
// secrets, so it stays guarded; so does anything untracked or ignored, a symlink
// to an untracked file (symlinks are resolved first), and anything this check
// cannot establish: no git, not a repository, git failing or timing out. The
// verdict is always "guarded" unless git said otherwise.
//
// The decision runs inside event application and must not do I/O beyond a stat,
// so the verdict is read from a cache here and git is only ever run by
// WarmEnvTracking, from the machine, off that path. A path with no fresh verdict
// counts as a miss and is guarded; the machine holds such an ask, warms the
// cache and decides it again (permissions_tree.go).

const (
	// envGitTimeoutDefault bounds one warm (all the paths in it share it).
	envGitTimeoutDefault = 2 * time.Second
	// envVerdictTTL is how long a verdict is trusted: the file's mtime and size
	// are part of the key, but a commit can move HEAD under an untouched file.
	envVerdictTTL = time.Minute
	// maxTrackedEnv is the largest file hashed.
	maxTrackedEnv = 1 << 20
	// maxPendingEnv bounds the paths waiting for a warm.
	maxPendingEnv = 64
)

// gitBinary is the git program, "" to behave as if there were none (tests); and
// envGitTimeout the bound on one warm.
var (
	gitBinary     = "git"
	envGitTimeout = envGitTimeoutDefault
)

type envVerdict struct {
	mod   time.Time
	size  int64
	clean bool
	at    time.Time
}

var envTrack = struct {
	mu      sync.Mutex
	cache   map[string]envVerdict
	pending map[string]bool
	misses  atomic.Uint64
}{cache: map[string]envVerdict{}, pending: map[string]bool{}}

// EnvTrackMisses counts the paths whose verdict was wanted and not at hand. A
// caller that sees it move across a decision knows the decision guarded a file
// it could not yet judge, and may WarmEnvTracking and decide again.
func EnvTrackMisses() uint64 { return envTrack.misses.Load() }

// envTrackable is whether a path's name is one the committed-file skip applies
// to: a .env, .env.* or *.env file. `.envrc` is direnv's, which runs code, and is
// never skipped.
func envTrackable(path string) bool {
	return isSensitive(path) && filepath.Base(path) != ".envrc"
}

// committedEnv reports whether path is a tracked env file with no local edit,
// from the cache only. False, and the path queued for the next warm, when there
// is no fresh verdict.
func committedEnv(path string) bool {
	if !envTrackable(path) || gitBinary == "" || strings.ContainsAny(path, "*?[") {
		return false
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return false
	}
	fi, err := os.Stat(real)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() > maxTrackedEnv {
		return false
	}
	envTrack.mu.Lock()
	defer envTrack.mu.Unlock()
	v, ok := envTrack.cache[real]
	if ok && v.mod.Equal(fi.ModTime()) && v.size == fi.Size() && time.Since(v.at) < envVerdictTTL {
		return v.clean
	}
	envTrack.misses.Add(1)
	if len(envTrack.pending) < maxPendingEnv {
		envTrack.pending[real] = true
	}
	return false
}

// WarmEnvTracking runs git for the paths committedEnv could not judge, within
// envGitTimeout, and keeps the verdicts. It does I/O and must never run in
// event application.
func WarmEnvTracking(ctx context.Context) {
	envTrack.mu.Lock()
	paths := make([]string, 0, len(envTrack.pending))
	for p := range envTrack.pending {
		paths = append(paths, p)
	}
	envTrack.pending = map[string]bool{}
	envTrack.mu.Unlock()
	if len(paths) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, envGitTimeout)
	defer cancel()
	for _, p := range paths {
		fi, err := os.Stat(p)
		if err != nil {
			continue
		}
		clean := gitCommitted(ctx, p)
		envTrack.mu.Lock()
		if len(envTrack.cache) > 2000 {
			envTrack.cache = map[string]envVerdict{}
		}
		envTrack.cache[p] = envVerdict{mod: fi.ModTime(), size: fi.Size(), clean: clean, at: time.Now()}
		envTrack.mu.Unlock()
	}
}

// gitCommitted reports whether the (symlink-resolved) file is in HEAD of the
// repository it sits in, and its content is that blob. HEAD, not the index: a
// file an agent merely staged is not committed. Any failure is false. The blob is
// hashed without filters, so no configured filter program is ever run.
func gitCommitted(ctx context.Context, path string) bool {
	dir, base := filepath.Dir(path), filepath.Base(path)
	tree, ok := gitOut(ctx, dir, "ls-tree", "-z", "HEAD", "--", base)
	if !ok {
		return false
	}
	// "<mode> blob <sha>\t<name>\x00", one entry: the file in this directory
	entry, _, _ := strings.Cut(string(tree), "\x00")
	meta, name, found := strings.Cut(entry, "\t")
	fields := strings.Fields(meta)
	if !found || name != base || len(fields) != 3 || fields[1] != "blob" || (fields[0] != "100644" && fields[0] != "100755") {
		return false
	}
	hash, ok := gitOut(ctx, dir, "hash-object", "--no-filters", "--", base)
	return ok && strings.TrimSpace(string(hash)) == fields[2]
}

func gitOut(ctx context.Context, dir string, args ...string) ([]byte, bool) {
	cmd := exec.CommandContext(ctx, gitBinary, args...)
	cmd.Dir = dir
	cmd.Env = gitEnv()
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, false
	}
	return out.Bytes(), true
}

// gitEnv is the environment git runs in: the machine's own, without anything
// that points git at another repository, and never asking for a credential.
func gitEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		switch k {
		case "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
			"GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM":
			continue
		}
		env = append(env, kv)
	}
	return append(env, "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C")
}
