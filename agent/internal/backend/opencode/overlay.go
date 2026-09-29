package opencode

import (
	"encoding/json"

	"galopin/internal/backend"
	"galopin/internal/fsutil"
)

// Mode and model are per-prompt in opencode (there is no server-side memory
// of a session's chosen mode/model between prompts), so this backend keeps
// its own overlay and passes it on every prompt_async call. The same file
// also durably remembers each user message's clientMessageId (PROTOCOL.md
// §7): opencode has no notion of it at all, so once this backend has
// matched a clientMessageId to the message a prompt produced, that mapping
// has to survive a restart on its own. Persisted to OverlayPath (if set).

// overlayFile is the whole persisted file's shape.
type overlayFile struct {
	Sessions map[string]sessionOverlay `json:"sessions"`
	// ClientMessageIDs maps an opencode message id to the clientMessageId
	// the prompt that created it carried.
	ClientMessageIDs map[string]string `json:"clientMessageIds"`
	// CommandMarkers maps the message id a command produced to the marker
	// the transcript shows (PROTOCOL.md §6 session.command) — never the
	// expanded template, only the name and the arguments as sent.
	CommandMarkers map[string]backend.MessageCommand `json:"commandMarkers,omitempty"`
	// SentMarkers maps the message id a session_send produced to its sender
	// (PROTOCOL.md §7 Message.sentBy).
	SentMarkers map[string]backend.MessageSender `json:"sentMarkers,omitempty"`
}

func (b *Backend) getOverlay(sessionID string) sessionOverlay {
	b.overlayMu.Lock()
	defer b.overlayMu.Unlock()
	return b.overlay[sessionID]
}

func (b *Backend) setOverlay(sessionID string, o sessionOverlay) error {
	b.overlayMu.Lock()
	b.overlay[sessionID] = o
	b.overlayMu.Unlock()
	return b.saveOverlay()
}

// resolveClientMessageID attaches a previously persisted mapping to msg if
// one exists for its id. Otherwise, if msg is a user message and a prompt
// on sessionID is still waiting to learn which message it produced (set by
// Prompt), this claims that pending clientMessageId for msg, persists the
// new mapping, and clears the pending entry — "map the clientMessageId to
// the next user message created for that session".
//
// The pending entry is the fallback half; the exact half is recorded by
// Prompt against the messageID it minted and sent. When a map hit lands on
// exactly that minted id, the server demonstrably honoured it, so the
// fallback claim is spent at the same moment — it must not linger and
// mis-tag some later, promptless user message on the session.
func (b *Backend) resolveClientMessageID(sessionID string, msg *backend.Message) {
	// The command marker rides on the message's own id, independent of the
	// clientMessageId mapping a prompt may or may not have carried.
	b.attachCommandMarker(msg)

	b.clientMsgMu.Lock()
	if id, ok := b.clientMessageIDs[msg.ID]; ok {
		b.clientMsgMu.Unlock()
		msg.ClientMessageID = id
		b.spendPendingClaim(sessionID, msg.ID)
		return
	}
	b.clientMsgMu.Unlock()

	if msg.Role != "user" {
		return
	}
	b.pendingMu.Lock()
	pending, ok := b.pendingClientMsg[sessionID]
	if ok {
		delete(b.pendingClientMsg, sessionID)
	}
	b.pendingMu.Unlock()
	if !ok {
		return
	}

	b.clientMsgMu.Lock()
	b.clientMessageIDs[msg.ID] = pending.clientMessageID
	b.clientMsgMu.Unlock()
	msg.ClientMessageID = pending.clientMessageID
	// Best effort: losing this on a crash between here and the write only
	// costs one message's id being unrecoverable after that crash, not
	// correctness of anything already sent to a client this epoch.
	_ = b.saveOverlay()
}

// attachCommandMarker puts the command marker on a user message the
// transcript is resolving, when that message is the one a command
// produced. Only user messages carry it.
func (b *Backend) attachCommandMarker(msg *backend.Message) {
	if msg.Role != "user" {
		return
	}
	msg.Command = b.commandMarkerFor(msg.ID)
	msg.SentBy = b.sentMarkerFor(msg.ID)
}

// spendPendingClaim clears sessionID's pending fallback claim when the id
// it was minted for has shown up in the transcript (i.e. the server kept
// it). A hit on any other id — the transcript re-lists old, already-mapped
// messages on every read — leaves the claim alone.
func (b *Backend) spendPendingClaim(sessionID, messageID string) {
	b.pendingMu.Lock()
	if pending, ok := b.pendingClientMsg[sessionID]; ok && pending.mintedID == messageID {
		delete(b.pendingClientMsg, sessionID)
	}
	b.pendingMu.Unlock()
}

// pendingClaim is one outstanding prompt's client-message mapping. The
// minted id rides along so the fallback can be spent the moment the exact
// mapping proves itself (see resolveClientMessageID).
type pendingClaim struct {
	clientMessageID string
	mintedID        string
}

// recordExactClientMessageID persists the primary mapping: the messageID
// Prompt minted and sent -> the clientMessageId it carried. Unlike the
// pending claim this is exact, so it is written (duly persisted) before the
// POST goes out.
func (b *Backend) recordExactClientMessageID(messageID, clientMessageID string) {
	b.clientMsgMu.Lock()
	b.clientMessageIDs[messageID] = clientMessageID
	b.clientMsgMu.Unlock()
	_ = b.saveOverlay()
}

// claimPendingClientMessageID records the fallback: if the server ignores
// or rewrites the minted messageID, the next new user message created for
// sessionID is tagged with clientMessageID instead. Called by Prompt when
// session.prompt carried one.
func (b *Backend) claimPendingClientMessageID(sessionID, mintedID, clientMessageID string) {
	if clientMessageID == "" {
		return
	}
	b.pendingMu.Lock()
	b.pendingClientMsg[sessionID] = pendingClaim{clientMessageID: clientMessageID, mintedID: mintedID}
	b.pendingMu.Unlock()
}

func (b *Backend) loadOverlay() error {
	if b.cfg.OverlayPath == "" {
		return nil
	}
	body, err := fsutil.ReadFileOrEmpty(b.cfg.OverlayPath)
	if err != nil {
		return err
	}
	if body == nil {
		return nil
	}
	var f overlayFile
	if err := json.Unmarshal(body, &f); err != nil {
		return err
	}
	b.overlayMu.Lock()
	if f.Sessions != nil {
		b.overlay = f.Sessions
	}
	b.overlayMu.Unlock()
	b.clientMsgMu.Lock()
	if f.ClientMessageIDs != nil {
		b.clientMessageIDs = f.ClientMessageIDs
	}
	b.clientMsgMu.Unlock()
	b.markerMu.Lock()
	if f.CommandMarkers != nil {
		b.commandMarkers = f.CommandMarkers
	}
	if f.SentMarkers != nil {
		b.sentMarkers = f.SentMarkers
	}
	b.markerMu.Unlock()
	return nil
}

func (b *Backend) saveOverlay() error {
	if b.cfg.OverlayPath == "" {
		return nil
	}
	b.overlayMu.Lock()
	sessions := make(map[string]sessionOverlay, len(b.overlay))
	for k, v := range b.overlay {
		sessions[k] = v
	}
	b.overlayMu.Unlock()

	b.clientMsgMu.Lock()
	clientMessageIDs := make(map[string]string, len(b.clientMessageIDs))
	for k, v := range b.clientMessageIDs {
		clientMessageIDs[k] = v
	}
	b.clientMsgMu.Unlock()

	b.markerMu.Lock()
	commandMarkers := make(map[string]backend.MessageCommand, len(b.commandMarkers))
	for k, v := range b.commandMarkers {
		commandMarkers[k] = v
	}
	sentMarkers := make(map[string]backend.MessageSender, len(b.sentMarkers))
	for k, v := range b.sentMarkers {
		sentMarkers[k] = v
	}
	b.markerMu.Unlock()

	body, err := json.MarshalIndent(overlayFile{
		Sessions:         sessions,
		ClientMessageIDs: clientMessageIDs,
		CommandMarkers:   commandMarkers,
		SentMarkers:      sentMarkers,
	}, "", "  ")
	if err != nil {
		return err
	}
	return fsutil.WriteFileAtomic(b.cfg.OverlayPath, append(body, '\n'), 0o600)
}

// recordCommandMarker remembers, durably, that the message the minted
// messageID names is the user message a command produced (PROTOCOL.md §6
// session.command): name and arguments only — the expanded template is
// never stored here, because it never needed storing.
func (b *Backend) recordCommandMarker(messageID, name, arguments string) {
	b.markerMu.Lock()
	if b.commandMarkers == nil {
		b.commandMarkers = map[string]backend.MessageCommand{}
	}
	b.commandMarkers[messageID] = backend.MessageCommand{Name: name, Arguments: arguments}
	b.markerMu.Unlock()
	_ = b.saveOverlay()
}

// commandMarkerFor looks up a message's command marker, nil when the
// message was not produced by a command.
func (b *Backend) commandMarkerFor(messageID string) *backend.MessageCommand {
	b.markerMu.Lock()
	defer b.markerMu.Unlock()
	if marker, ok := b.commandMarkers[messageID]; ok {
		marker := marker
		return &marker
	}
	return nil
}
