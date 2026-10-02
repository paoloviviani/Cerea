// Package opencode implements internal/backend.Backend over `opencode
// serve`'s HTTP + SSE API (verified live against 1.18.31; PROTOCOL.md §2/§3
// records why this backend targets the server API rather than `opencode
// acp`). The agent spawns and supervises the opencode process itself: this
// package owns its lifecycle end to end, from picking a port through
// restarting it with backoff if it dies to killing it (and anything it
// spawned) on Stop.
package opencode

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"galopin/internal/attach"
	"galopin/internal/backend"
	"galopin/internal/permrules"
)

// Config is everything needed to spawn and reach one opencode instance.
type Config struct {
	// AttachmentCacheBytes bounds the tool-image cache (default 64 MiB); the
	// live IT shrinks it to force the re-read path.
	AttachmentCacheBytes int64
	// SSEMaxLineBytes bounds one line of opencode's event stream (default
	// 128 MiB); a longer one is skipped and its session resynced. The live IT
	// lowers it to exercise that path.
	SSEMaxLineBytes int
	// Bin is the opencode binary (default "opencode": resolved via PATH).
	Bin string
	// Hostname/Port are what opencode serve binds. Port 0 picks a free one.
	Hostname string
	Port     int
	// Password is OPENCODE_SERVER_PASSWORD (basic auth, user "opencode").
	// A random one is minted if empty.
	Password string
	// ConfigPath, if set, is exported as OPENCODE_CONFIG so a caller (tests,
	// --opencode-config) can point opencode at a specific config file
	// instead of its usual discovery.
	ConfigPath string
	// Env, if non-nil, replaces the child's environment outright (tests use
	// this for an isolated HOME/XDG_*, and to point at a mock LLM). Nil
	// means inherit os.Environ().
	Env []string
	// OverlayPath, if set, persists the per-session mode/model overlay
	// (opencode has no server-side memory of a session's chosen mode/model
	// across prompts) across agent restarts.
	OverlayPath string
	// StateDir is galopin's own state directory, whose command listing is
	// the baseline the workspace list is diffed against for origin
	// (backend.commands). Empty skips the diff: every non-builtin command
	// then reads as "machine".
	StateDir string
	// TmpDir, if set, is opencode's own TMPDIR, emptied before every start.
	// opencode is a Bun single-file binary that extracts its native
	// libraries (~5 MB of .so each start) into TMPDIR and never removes
	// them; on a machine whose /tmp is tmpfs, a supervisor restarting it
	// would slowly fill RAM. Nothing else lives there between starts.
	TmpDir string
	// ToolsDir, if set, is the directory galopin owns for its own opencode
	// tools (session_list/session_spawn/session_send, tools.go): written at
	// every start and exported as OPENCODE_CONFIG_DIR. Empty installs no
	// tools and the agentTools capability is false.
	ToolsDir string
	// ProjectConfig is whether opencode may load a workspace's own config
	// (opencode.json, .opencode/, AGENTS.md). False (the zero value) starts
	// opencode with OPENCODE_DISABLE_PROJECT_CONFIG=1. True loads it, and
	// then the ConfigPath file is also handed over inline as
	// OPENCODE_CONFIG_CONTENT — the layer above the project's — with
	// model/small_model pinned to the gateway, so the repo cannot redirect
	// the provider or pick another default model (see pinnedConfig).
	ProjectConfig bool
	// BackgroundSubagents is whether opencode may run background subagents
	// (task background:true, 1.18.32). True exports
	// OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1; false (the zero value)
	// strips any inherited value, so background:true fails closed inside
	// opencode. Set only from policy.BackgroundSubagentsAllowed.
	BackgroundSubagents bool
	// Permissions supplies the machine's two permission inputs — its own
	// rules and its ceiling — live, so a ceiling tightened while the process
	// runs is seen by the next session, prompt and restart. Nil applies none
	// (opencode's own rules alone, as before the permission pass-through).
	Permissions func() permrules.Layers
	// StartupTimeout bounds Start's wait for the first health check
	// (default 30s). A first run on a cold cache can be slower than that;
	// the integration test overrides it rather than this package assuming
	// every environment is warm.
	StartupTimeout time.Duration
	// Logf receives lifecycle-only messages: started, healthy, restarting,
	// exited (R6 — never frame or response bodies).
	Logf func(format string, args ...any)
}

const (
	defaultStartupTimeout = 30 * time.Second
	healthPollEvery       = 200 * time.Millisecond
	restartMinDelay       = time.Second
	restartMaxDelay       = 30 * time.Second
	stopGrace             = 3 * time.Second
)

// Backend is internal/backend.Backend over one supervised opencode
// process.
type Backend struct {
	cfg Config

	// att holds the images tool calls produced (attachments.go).
	att *attach.Store

	client *http.Client
	// longClient carries the calls that legitimately run long — today only
	// POST /session/:id/command, which blocks for the whole turn. The fast
	// CRUD client's doJSONTimeout would cut it off mid-turn.
	longClient *http.Client

	mu      sync.Mutex
	cmd     *exec.Cmd
	exited  chan struct{}
	stopped bool
	// deliberate is set by RestartForPolicy before it ends the process, so the
	// supervise loop starts the next one at once instead of after the backoff
	// a crash earns.
	deliberate bool
	// onStart is run at every start of the process (backend.RuleHost).
	onStart func()

	// perm is the permission pass-through's bookkeeping (permissions.go).
	perm permState

	stopCh chan struct{}
	doneCh chan struct{}
	// lifecycle is the context Start was called with: the process's own
	// lifetime. A command's blocking POST runs on it, not on the request
	// context that accepted the run — an op reply must not cancel a turn.
	lifecycle context.Context
	// commandsMu guards the /doc probe's cache: commandsCacheGen is the
	// backend generation the answer belongs to (bumped per supervised
	// start), so a restart re-probes.
	commandsMu  sync.Mutex
	backendGen  int
	commandsGen int
	commandsPtr *bool
	// stateCmdMu/stateCmdBaseline cache the state directory's command
	// listing for the process's lifetime (backend.commands's origin
	// proofs): full entries, so builtin metadata and machine-scope hashes
	// both compare against the same baseline.
	stateCmdMu       sync.Mutex
	stateCmdBaseline map[string]listedCommand
	// markerMu/commandMarkers map a command's minted messageID to the
	// transcript marker, persisted alongside the id map.
	markerMu       sync.Mutex
	commandMarkers map[string]backend.MessageCommand
	// injectMu/injectCh is where backend-generated events enter the
	// Subscribe stream (a late command failure). Nil until Subscribe runs.
	injectMu sync.Mutex
	injectCh chan backend.BackendEvent

	overlayMu sync.Mutex
	overlay   map[string]sessionOverlay

	// toolsMu guards the galopin tool relay (tools.go): the loopback server
	// plus its held approvals, and the handler answering the calls.
	toolsMu       sync.Mutex
	tools         *toolPlan
	toolHandlerFn backend.ToolHandler
	// sentMarkers maps a session_send message's minted id to its sender,
	// persisted with the overlay (guarded by markerMu).
	sentMarkers map[string]backend.MessageSender

	// clientMsgMu/clientMessageIDs is the durable half of the
	// clientMessageId mapping (PROTOCOL.md §7): opencode message id ->
	// clientMessageId, persisted alongside the overlay. Since prompt_async
	// takes a minted messageID, Prompt records this half before the POST —
	// exact, not guessed. pendingMu/pendingClientMsg is the transient
	// half — a sessionID -> pendingClaim waiting for the user message to
	// show up in an event, spent at once when the minted id itself turns
	// out to have been honoured — and is not persisted: losing a pending
	// entry to a crash only means one message's id can't be recovered, not
	// a correctness problem.
	clientMsgMu      sync.Mutex
	clientMessageIDs map[string]string
	pendingMu        sync.Mutex
	pendingClientMsg map[string]pendingClaim

	// modelsMu/modelLimits caches GET /config/providers's context-window
	// hints per model id, so Usage events (which only carry token counts)
	// can fill in ContextMax without a request per event.
	modelsMu   sync.Mutex
	modelLimit map[string]int

	// usageMu/sessionUsage remembers each session's latest Usage as it's
	// observed on the event stream (opencode's own session object carries
	// no usage field, only assistant messages do), so session.get/list can
	// answer with it instead of nothing until a caller asks for the full
	// Transcript.
	usageMu      sync.Mutex
	sessionUsage map[string]*backend.Usage
}

type sessionOverlay struct {
	ModeID  string `json:"modeId,omitempty"`
	ModelID string `json:"modelId,omitempty"`
	// SpawnedBy marks a session_spawn session (PROTOCOL.md §7).
	SpawnedBy *backend.SpawnedBy `json:"spawnedBy,omitempty"`
	// Effort is the model variant id sent with every prompt (opencode's
	// thinking-effort knob), "" for the model's default.
	Effort string `json:"effort,omitempty"`
	// RulesFP fingerprints the rules galopin last gave this session, so they
	// are re-sent only on change and survive an agent restart without growing
	// the session's rule list.
	RulesFP string `json:"rulesFp,omitempty"`
	// Panel is what a person set on this session (session.setRules), kept so
	// every re-send of the session's rules carries it, in the same place.
	Panel permrules.Panel `json:"panel,omitempty"`
}

// New builds a Backend. Start must be called before any other method.
func New(cfg Config) *Backend {
	if cfg.Bin == "" {
		cfg.Bin = "opencode"
	}
	if cfg.Hostname == "" {
		cfg.Hostname = "127.0.0.1"
	}
	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}
	return &Backend{
		cfg:              cfg,
		att:              attach.New(cfg.AttachmentCacheBytes),
		client:           &http.Client{},
		longClient:       &http.Client{},
		overlay:          map[string]sessionOverlay{},
		clientMessageIDs: map[string]string{},
		pendingClientMsg: map[string]pendingClaim{},
		modelLimit:       map[string]int{},
		sessionUsage:     map[string]*backend.Usage{},
		commandMarkers:   map[string]backend.MessageCommand{},
	}
}

// ID/Version implement backend.Backend. Version is the opencode release
// the live integration tests are pinned to (1.18.32): hello reports it,
// and the capability probe never consults it.
func (b *Backend) ID() string      { return "opencode" }
func (b *Backend) Version() string { return "1.18.32" }

// lifecycleContext returns the context Start was called with, or ok=false
// when Start has not completed (or was never called).
func (b *Backend) lifecycleContext() (context.Context, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.lifecycle == nil {
		return nil, false
	}
	return b.lifecycle, true
}

func pickFreePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func randomHex(n int) (string, error) {
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

// Start picks a port and password if not already set, launches the
// supervise loop, and waits for the first health check to pass.
//
// A bare cfg.Bin name is resolved against PATH here, before any loop: a
// missing binary is a permanent condition, and letting the supervise loop
// find out per attempt (exec reports it from Wait, after the process table
// entry exists) burns the whole backoff ladder on a machine that can never
// come healthy. The absolute-path case keeps exec's own check: the file
// being gone between Start and the first launch is the restart loop's
// problem, not a startup one.
func (b *Backend) Start(ctx context.Context) error {
	if !strings.ContainsRune(b.cfg.Bin, '/') {
		// PATH first (the ordinary case), then the opencode installer's own
		// directory: opencode.ai/install puts the binary in
		// $HOME/.opencode/bin and only joins it to PATH via the rc files —
		// so a shell that just installed it (galopin's printed one-liner
		// does exactly that) cannot see it until the next login. Falling
		// back here is what makes the fresh-machine one-liner work in one
		// shot, without an export step.
		if resolved, err := exec.LookPath(b.cfg.Bin); err == nil {
			b.cfg.Bin = resolved
		} else if home, homeErr := os.UserHomeDir(); homeErr == nil {
			if candidate := filepath.Join(home, ".opencode", "bin", "opencode"); fileExecutable(candidate) {
				b.cfg.Bin = candidate
			} else {
				return fmt.Errorf(
					"opencode: the %q binary was not found on PATH or in $HOME/.opencode/bin — galopin runs it as its agent; install it first (https://opencode.ai/install) or point --opencode-bin at it",
					b.cfg.Bin,
				)
			}
		} else {
			return fmt.Errorf(
				"opencode: the %q binary was not found on PATH — galopin runs it as its agent; install it first (https://opencode.ai/install) or point --opencode-bin at it",
				b.cfg.Bin,
			)
		}
	}
	if b.cfg.Port == 0 {
		port, err := pickFreePort()
		if err != nil {
			return fmt.Errorf("opencode: picking a port: %w", err)
		}
		b.cfg.Port = port
	}
	if b.cfg.Password == "" {
		pw, err := randomHex(16)
		if err != nil {
			return fmt.Errorf("opencode: minting server password: %w", err)
		}
		b.cfg.Password = pw
	}
	if err := b.loadOverlay(); err != nil {
		return err
	}
	if err := b.startTools(); err != nil {
		return err
	}
	b.mu.Lock()
	b.lifecycle = ctx
	b.mu.Unlock()

	b.stopCh = make(chan struct{})
	b.doneCh = make(chan struct{})
	go b.superviseLoop(ctx)

	timeout := b.cfg.StartupTimeout
	if timeout == 0 {
		timeout = defaultStartupTimeout
	}
	if err := b.waitHealthy(ctx, timeout); err != nil {
		return err
	}
	b.cfg.Logf("opencode: healthy on %s", b.baseURL())
	return nil
}

func (b *Backend) baseURL() string {
	return fmt.Sprintf("http://%s:%d", b.cfg.Hostname, b.cfg.Port)
}

// fileExecutable reports whether stat succeeds and any executable bit is
// set — the check LookPath would do, against a path we constructed.
func fileExecutable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode()&0o111 != 0
}

// superviseLoop keeps opencode running: launch, wait for it to exit, and —
// unless Stop was called — relaunch after a backoff.
func (b *Backend) superviseLoop(ctx context.Context) {
	defer close(b.doneCh)
	delay := restartMinDelay
	first := true
	for {
		select {
		case <-ctx.Done():
			return
		case <-b.stopCh:
			return
		default:
		}
		err := b.runOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-b.stopCh:
			return
		default:
		}
		b.mu.Lock()
		deliberate := b.deliberate
		b.deliberate = false
		b.mu.Unlock()
		if deliberate {
			// RestartForPolicy ended it: start the next one now, and forget
			// the backoff a string of crashes had built.
			b.cfg.Logf("opencode: restarting to apply a tightened policy")
			delay = restartMinDelay
			first = false
			continue
		}
		if !first {
			b.cfg.Logf("opencode: exited (%v), restarting in %s", err, delay)
		} else {
			b.cfg.Logf("opencode: exited before becoming healthy (%v), retrying in %s", err, delay)
		}
		first = false
		select {
		case <-ctx.Done():
			return
		case <-b.stopCh:
			return
		case <-time.After(delay):
		}
		delay *= 2
		if delay > restartMaxDelay {
			delay = restartMaxDelay
		}
	}
}

func (b *Backend) runOnce(ctx context.Context) error {
	args := []string{"serve", "--hostname", b.cfg.Hostname, "--port", fmt.Sprint(b.cfg.Port)}
	if !b.cfg.ProjectConfig {
		// OPENCODE_DISABLE_PROJECT_CONFIG skips a repo's config, commands and
		// MCP servers but NOT its .opencode/plugin(s) (probed live on
		// 1.18.32: the plugin still ran); --pure is what stops those.
		args = append(args, "--pure")
	}
	cmd := exec.Command(b.cfg.Bin, args...)
	env := b.cfg.Env
	if env == nil {
		env = os.Environ()
	}
	env = append(append([]string{}, env...), "OPENCODE_SERVER_PASSWORD="+b.cfg.Password)
	if b.cfg.TmpDir != "" {
		// The previous start's extracted libraries are dead now: clear them.
		if err := os.RemoveAll(b.cfg.TmpDir); err != nil {
			return fmt.Errorf("clearing opencode's temp dir: %w", err)
		}
		if err := os.MkdirAll(b.cfg.TmpDir, 0o700); err != nil {
			return fmt.Errorf("creating opencode's temp dir: %w", err)
		}
		kept := env[:0]
		for _, kv := range env {
			if !strings.HasPrefix(kv, "TMPDIR=") {
				kept = append(kept, kv)
			}
		}
		env = append(kept, "TMPDIR="+b.cfg.TmpDir)
	}
	if b.cfg.ConfigPath != "" {
		env = append(env, "OPENCODE_CONFIG="+b.cfg.ConfigPath)
	}
	// The project-config and background-subagent switches are galopin's
	// alone: an inherited value (a repo's .envrc, say) never decides them.
	env = stripChildSwitches(env)
	if b.cfg.BackgroundSubagents {
		env = append(env, "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1")
	}
	// OPENCODE_CONFIG_CONTENT is the layer above every file, a project's
	// included. It carries the pinned gateway config when the machine loads
	// project config, and always the permission floor: the ceiling restated as
	// agent-level rules, rebuilt from the current policy at every start (see
	// permrules.Floor for why it is agent-level and why only some agents get
	// an entry).
	var content map[string]any
	if !b.cfg.ProjectConfig {
		env = append(env, "OPENCODE_DISABLE_PROJECT_CONFIG=1")
	} else if b.cfg.ConfigPath != "" {
		pinned, err := pinnedConfig(b.cfg.ConfigPath)
		if err != nil {
			return fmt.Errorf("pinning the gateway config: %w", err)
		}
		if err := json.Unmarshal([]byte(pinned), &content); err != nil {
			return fmt.Errorf("pinning the gateway config: %w", err)
		}
	}
	if b.cfg.Permissions != nil || content != nil {
		body, err := floorConfig(content, b.layers().Ceiling)
		if err != nil {
			return fmt.Errorf("building the permission floor: %w", err)
		}
		env = append(env, "OPENCODE_CONFIG_CONTENT="+body)
	}
	env = append(env, b.toolEnv()...)
	cmd.Env = env
	cmd.Stdout = nil
	cmd.Stderr = nil
	setProcAttrs(cmd)

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("starting opencode: %w", err)
	}
	// A new process is a new server: the cached /doc probe answer belongs to
	// the previous one, so the next capabilities() call re-probes.
	b.commandsMu.Lock()
	b.backendGen++
	b.commandsMu.Unlock()
	b.processStarted()
	exited := make(chan struct{})
	b.mu.Lock()
	b.cmd = cmd
	b.exited = exited
	b.mu.Unlock()

	err := cmd.Wait()
	close(exited)
	b.mu.Lock()
	b.cmd = nil
	b.mu.Unlock()
	return err
}

// stripChildSwitches drops the opencode switches galopin owns outright, so
// an inherited value never decides them. The background-subagent flag is
// then set only from Config.BackgroundSubagents (fail-closed: absent means
// opencode refuses background:true inside the task tool).
func stripChildSwitches(env []string) []string {
	kept := env[:0]
	for _, kv := range env {
		if !strings.HasPrefix(kv, "OPENCODE_DISABLE_PROJECT_CONFIG=") && !strings.HasPrefix(kv, "OPENCODE_CONFIG_CONTENT=") && !strings.HasPrefix(kv, "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=") {
			kept = append(kept, kv)
		}
	}
	return kept
}

func (b *Backend) waitHealthy(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	url := b.baseURL() + "/global/health"
	for {
		// Each attempt gets its own short deadline, not the caller's whole
		// timeout: a single hung connection attempt (found live — a request
		// that never completed even though the server answered a fresh curl
		// instantly moments later) must not stall every later attempt behind
		// it. A fresh request each iteration also means a bad pooled
		// connection doesn't keep getting reused.
		attemptCtx, cancel := context.WithTimeout(ctx, healthPollEvery*10)
		req, err := http.NewRequestWithContext(attemptCtx, http.MethodGet, url, nil)
		if err == nil {
			req.SetBasicAuth("opencode", b.cfg.Password)
			resp, doErr := b.client.Do(req)
			if doErr == nil {
				resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					cancel()
					return nil
				}
			}
		}
		cancel()
		if time.Now().After(deadline) {
			return fmt.Errorf("opencode: did not become healthy within %s", timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(healthPollEvery):
		}
	}
}

// Stop asks the supervise loop to stop restarting, then SIGTERMs the
// current process (group), escalating to SIGKILL after stopGrace if it
// hasn't exited. Idempotent; safe to call even if Start never completed.
func (b *Backend) Stop() error {
	b.mu.Lock()
	if b.stopped {
		b.mu.Unlock()
		return nil
	}
	b.stopped = true
	stopCh, doneCh := b.stopCh, b.doneCh
	cmd, exited := b.cmd, b.exited
	b.mu.Unlock()

	if stopCh != nil {
		close(stopCh)
	}
	if cmd != nil && cmd.Process != nil {
		signalGroupTerm(cmd)
		select {
		case <-exited:
		case <-time.After(stopGrace):
			signalGroupKill(cmd)
			<-exited
		}
	}
	if doneCh != nil {
		<-doneCh
	}
	b.stopTools()
	return b.saveOverlay()
}
