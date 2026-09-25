package terminal

import "testing"

func TestModeTrackerDefaultPreludeIsEmpty(t *testing.T) {
	m := NewModeTracker()
	if p := m.Prelude(); len(p) != 0 {
		t.Fatalf("fresh tracker should have an empty prelude, got %q", p)
	}
}

func TestModeTrackerAltScreenAndCursor(t *testing.T) {
	m := NewModeTracker()
	m.Feed([]byte("\x1b[?1049h\x1b[?25l"))
	want := "\x1b[?1049h\x1b[?25l"
	if got := string(m.Prelude()); got != want {
		t.Fatalf("prelude = %q, want %q", got, want)
	}
}

func TestModeTrackerResetTurnsModesOff(t *testing.T) {
	m := NewModeTracker()
	m.Feed([]byte("\x1b[?1049h\x1b[?2004h"))
	m.Feed([]byte("\x1b[?1049l"))
	want := "\x1b[?2004h"
	if got := string(m.Prelude()); got != want {
		t.Fatalf("prelude = %q, want %q (alt screen was turned back off)", got, want)
	}
}

func TestModeTrackerSplitAcrossFeeds(t *testing.T) {
	m := NewModeTracker()
	full := "\x1b[?1049h"
	for i := range full {
		m.Feed([]byte{full[i]})
	}
	if got := string(m.Prelude()); got != full {
		t.Fatalf("byte-at-a-time feed: prelude = %q, want %q", got, full)
	}
}

func TestModeTrackerAllFourModes(t *testing.T) {
	m := NewModeTracker()
	m.Feed([]byte("\x1b[?1049h\x1b[?2004h\x1b[?25l\x1b[?1h"))
	want := "\x1b[?1049h\x1b[?2004h\x1b[?25l\x1b[?1h"
	if got := string(m.Prelude()); got != want {
		t.Fatalf("prelude = %q, want %q", got, want)
	}
}
