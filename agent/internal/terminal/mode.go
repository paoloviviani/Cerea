package terminal

import (
	"strings"
	"sync"
)

// ModeTracker follows the handful of terminal modes a fresh viewer needs
// replayed before it can render correctly: alternate screen, bracketed
// paste, cursor visibility and application-cursor mode (PROTOCOL.md §9.3
// terminal.attach, plan §5.2). It only ever looks at CSI private-mode
// set/reset sequences (`ESC [ ? <params> h` / `l`); everything else in the
// stream passes through it untouched (the ring holds the real bytes; this
// only mirrors state for the prelude).
type ModeTracker struct {
	mu             sync.Mutex
	altScreen      bool
	bracketedPaste bool
	cursorHidden   bool
	appCursor      bool
	partial        []byte // an incomplete CSI sequence split across two Feed calls
}

// NewModeTracker returns a tracker in the terminal's power-on defaults:
// normal screen, no bracketed paste, cursor visible, normal cursor keys.
func NewModeTracker() *ModeTracker { return &ModeTracker{} }

// Feed scans p for the modes this tracker follows. It is safe to call from
// the same goroutine that also writes p to the Ring, and nowhere else needs
// to call it.
func (m *ModeTracker) Feed(p []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	data := p
	if len(m.partial) > 0 {
		data = append(append([]byte{}, m.partial...), p...)
		m.partial = nil
	}
	i := 0
	for i < len(data) {
		if data[i] != 0x1b {
			i++
			continue
		}
		if i+1 >= len(data) {
			m.partial = append([]byte{}, data[i:]...)
			break
		}
		if data[i+1] != '[' {
			i++
			continue
		}
		j := i + 2
		for j < len(data) && data[j] >= 0x30 && data[j] <= 0x3f {
			j++
		}
		for j < len(data) && data[j] >= 0x20 && data[j] <= 0x2f {
			j++
		}
		if j >= len(data) {
			m.partial = append([]byte{}, data[i:]...)
			break
		}
		final := data[j]
		if final < 0x40 || final > 0x7e {
			i = j + 1
			continue
		}
		m.applyLocked(string(data[i+2:j]), final)
		i = j + 1
	}
}

func (m *ModeTracker) applyLocked(params string, final byte) {
	if !strings.HasPrefix(params, "?") || (final != 'h' && final != 'l') {
		return
	}
	set := final == 'h'
	for _, code := range strings.Split(params[1:], ";") {
		switch code {
		case "1049", "47":
			m.altScreen = set
		case "2004":
			m.bracketedPaste = set
		case "25":
			m.cursorHidden = !set
		case "1":
			m.appCursor = set
		}
	}
}

// Prelude renders the escape sequences that bring a fresh terminal to the
// tracked state — what a `reset` attach writes before the live stream
// (PROTOCOL.md §9.3).
func (m *ModeTracker) Prelude() []byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	var b strings.Builder
	if m.altScreen {
		b.WriteString("\x1b[?1049h")
	}
	if m.bracketedPaste {
		b.WriteString("\x1b[?2004h")
	}
	if m.cursorHidden {
		b.WriteString("\x1b[?25l")
	}
	if m.appCursor {
		b.WriteString("\x1b[?1h")
	}
	return []byte(b.String())
}
