package opencode

import (
	"context"
	"strings"
	"unicode/utf8"

	"galopin/internal/backend"
)

// opencode 1.x gave a new session the title "New session - <date>"; 2.x leaves
// it empty until its title agent has named the session, and when that call
// fails or returns nothing (a provider that rejects it, a model that answers
// with an empty line) it stays empty. Until a title exists galopin lends the
// session a short name from its first prompt, so no panel falls back to the
// folder path.

const (
	promptNameWords = 6
	promptNameRunes = 48
)

// promptName is the first words of a prompt as a one-line name: whitespace
// collapsed, at most promptNameWords words and promptNameRunes runes, "…" when
// cut. "" when the prompt has no words.
func promptName(text string) string {
	words := strings.Fields(text)
	if len(words) == 0 {
		return ""
	}
	cut := false
	if len(words) > promptNameWords {
		words, cut = words[:promptNameWords], true
	}
	name := strings.Join(words, " ")
	if utf8.RuneCountInString(name) > promptNameRunes {
		r := []rune(name)[:promptNameRunes]
		name = strings.TrimSpace(string(r))
		cut = true
	}
	name = strings.TrimRight(name, " .,;:-")
	if cut {
		name += "…"
	}
	return name
}

// nameUntitled gives a top-level session without a title its stand-in name.
func (b *Backend) nameUntitled(s *backend.Session) {
	if s.Title != "" || s.ParentID != "" {
		return
	}
	s.Title = b.getOverlay(s.ID).Name
}

// nameFromFirstPrompt remembers the stand-in name of a session's first prompt
// and, when opencode has not titled the session yet, tells subscribers.
func (b *Backend) nameFromFirstPrompt(ctx context.Context, workspaceDir, sessionID, text string) {
	ov := b.getOverlay(sessionID)
	if ov.Name != "" {
		return
	}
	name := promptName(text)
	if name == "" {
		return
	}
	ov.Name = name
	if err := b.setOverlay(sessionID, ov); err != nil {
		b.cfg.Logf("opencode: could not remember the name of session %s: %v", sessionID, err)
		return
	}
	s, err := b.GetSession(ctx, workspaceDir, sessionID)
	if err != nil || s.ParentID != "" {
		return
	}
	b.emitInjected(workspaceDir, sessionID, backend.Event{Kind: backend.EventSession, Session: &s})
}
