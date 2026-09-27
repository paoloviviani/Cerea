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

	body, err := json.MarshalIndent(overlayFile{Sessions: sessions, ClientMessageIDs: clientMessageIDs}, "", "  ")
	if err != nil {
		return err
	}
	return fsutil.WriteFileAtomic(b.cfg.OverlayPath, append(body, '\n'), 0o600)
}
