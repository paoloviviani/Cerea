package mcpconn

import (
	"fmt"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// logSink collects the hub's log lines.
type logSink struct {
	mu    sync.Mutex
	lines []string
}

func (l *logSink) logf(format string, args ...any) {
	l.mu.Lock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
	l.mu.Unlock()
}

func (l *logSink) matching(sub string) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []string
	for _, line := range l.lines {
		if strings.Contains(line, sub) {
			out = append(out, line)
		}
	}
	return out
}

func (l *logSink) waitFor(t *testing.T, sub string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if got := l.matching(sub); len(got) > 0 {
			return got[0]
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no log line containing %q in %q", sub, l.lines)
	return ""
}

func TestServerStartAndStopAreLoggedWithTheirReason(t *testing.T) {
	var logs logSink
	r := newRig(t, fakeConfig("", `, "args": ["--secret-arg"]`), func(c *Config) {
		c.Logf = logs.logf
		c.IdleTimeout = 400 * time.Millisecond
	})

	// Started: the pid and the channel, nothing of the entry's args or env.
	ch := r.open("fake")
	started := logs.waitFor(t, "started")
	if !regexp.MustCompile(`^connectors: fake: started \(pid [0-9]+, channel ` + ch + `\)$`).MatchString(started) {
		t.Errorf("start line = %q", started)
	}

	// Idle.
	r.nextClosed()
	if got := logs.waitFor(t, "channel "+ch+", idle"); got != "connectors: fake: stopped (channel "+ch+", idle)" {
		t.Errorf("idle line = %q", got)
	}

	// Closed by Cerea.
	ch = r.open("fake")
	r.hub.Close(ch)
	logs.waitFor(t, "stopped (channel "+ch+", closed)")

	// Link down.
	ch = r.open("fake")
	r.hub.LinkDown()
	logs.waitFor(t, "stopped (channel "+ch+", link down)")

	for _, line := range logs.lines {
		if strings.Contains(line, "secret-arg") || strings.Contains(line, "FAKE_VALUE") || strings.Contains(line, "MCPFAKE") {
			t.Errorf("a log line leaks the entry: %q", line)
		}
	}
}

func TestServerCrashAndConfigChangeAreLoggedWithTheirReason(t *testing.T) {
	var logs logSink
	r := newRig(t, fakeConfig("crash", ""), func(c *Config) { c.Logf = logs.logf })
	ch := r.open("fake")
	r.hub.Message(ch, []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_file"}}`))
	r.nextClosed()
	// The exit status, not what the process wrote to stderr.
	if got := logs.waitFor(t, "channel "+ch+", crashed"); got != "connectors: fake: stopped (channel "+ch+", crashed: exit status 3)" {
		t.Errorf("crash line = %q", got)
	}

	ch = r.open("fake")
	writeConfig(t, r.dir+"/mcp.json", `{"mcpServers":{}}`)
	r.hub.Reload()
	r.nextClosed()
	logs.waitFor(t, "stopped (channel "+ch+", config)")
}
