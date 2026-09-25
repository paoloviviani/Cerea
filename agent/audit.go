package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// auditLoggerMaxBytes rotates audit.log once it passes this size, keeping
// exactly one previous generation (audit.log.1) — enough to survive a
// terminal session or two of refusals without growing without bound.
const auditLoggerMaxBytes = 5 << 20

// auditLogger is galopin's local record of terminal opens/closes and policy
// refusals (PROTOCOL.md §9.3, ADR 0090 §7): the one Cerea cannot rewrite,
// because it never leaves this machine. It NEVER records keystrokes,
// terminal output, or file content — every method here takes only
// identifiers and metadata, never a byte of what passed through a session.
type auditLogger struct {
	mu   sync.Mutex
	path string
	file *os.File
}

// newAuditLogger opens (creating if needed) <stateDir>/audit.log at 0600,
// appending.
func newAuditLogger(stateDir string) (*auditLogger, error) {
	path := filepath.Join(stateDir, "audit.log")
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("opening audit log: %w", err)
	}
	return &auditLogger{path: path, file: f}, nil
}

// Close closes the underlying file.
func (a *auditLogger) Close() error {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.file.Close()
}

// write appends one JSON-line entry, rotating first if the file has grown
// past auditLoggerMaxBytes. Nil-receiver-safe: every public method on
// *auditLogger is, so callers never need a nil check of their own (run.go
// wires a real one; tests that don't care simply never call AttachAudit,
// leaving machine.audit nil).
func (a *auditLogger) write(entry map[string]any) {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if info, err := a.file.Stat(); err == nil && info.Size() > auditLoggerMaxBytes {
		a.rotateLocked()
	}
	entry["at"] = time.Now().UTC().Format(time.RFC3339Nano)
	body, err := json.Marshal(entry)
	if err != nil {
		return
	}
	body = append(body, '\n')
	_, _ = a.file.Write(body)
}

func (a *auditLogger) rotateLocked() {
	_ = a.file.Close()
	_ = os.Rename(a.path, a.path+".1")
	f, err := os.OpenFile(a.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	a.file = f
}

// terminalOpen records that a terminal was opened: id, cwd, shell, and the
// timestamp write adds — never a byte of what the shell prints or receives.
func (a *auditLogger) terminalOpen(id, cwd, shell string) {
	a.write(map[string]any{"action": "terminal.open", "id": id, "cwd": cwd, "shell": shell})
}

// terminalClose records that a terminal closed (exited, was closed, or was
// torn down by a revoke).
func (a *auditLogger) terminalClose(id string) {
	a.write(map[string]any{"action": "terminal.close", "id": id})
}

// refusal records a policy veto: which op was refused and why, never the
// arguments that op carried.
func (a *auditLogger) refusal(op, reason string) {
	a.write(map[string]any{"action": "refusal", "op": op, "reason": reason})
}
