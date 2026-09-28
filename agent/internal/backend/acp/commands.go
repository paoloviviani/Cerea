package acp

import (
	"context"

	"galopin/internal/backend"
)

// The commands capability over ACP (PROTOCOL.md §6 backend.commands /
// session.command): the agent's own available_commands_update is the whole
// list, cached per session as it arrives, and a run is an ordinary prompt
// whose text is "/<name> <arguments>".

// ListCommands implements backend.Commander: the last
// available_commands_update cached for this session, empty before the
// first one arrives — the same answer an agent that never sends the update
// would give. workspaceDir is unused: the list is per session, not per
// directory. Nothing is claimed that the update did not carry: no origin,
// no template, so shell is unknown and the commandShell policy gates every
// ACP command until an owner opts in.
func (b *Backend) ListCommands(_ context.Context, _, sessionID string) ([]backend.Command, error) {
	st, ok := b.reg.get(sessionID)
	if !ok {
		return []backend.Command{}, nil
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	return append([]backend.Command{}, st.commands...), nil
}

// RunCommand implements backend.Commander's run half: refuse while the
// session is mid-turn (a second prompt would overwrite the turn ids — the
// same sentinel Prompt itself guards with), then send the command as an
// ordinary prompt whose text is the invocation. The marker rides on the
// user message this backend synthesizes, because ACP's live mode never
// echoes one (PROTOCOL.md §6 session.command).
func (b *Backend) RunCommand(ctx context.Context, workspaceDir, sessionID string, run backend.CommandRun) error {
	if st, ok := b.reg.get(sessionID); ok {
		st.mu.Lock()
		busy := st.busy
		st.mu.Unlock()
		if busy {
			return backend.ErrSessionBusy
		}
	}
	text := "/" + run.Name
	if run.Arguments != "" {
		text += " " + run.Arguments
	}
	return b.Prompt(ctx, workspaceDir, sessionID, backend.Prompt{
		Text:            text,
		ClientMessageID: run.ClientMessageID,
		Attachments:     run.Attachments,
		Command:         &backend.MessageCommand{Name: run.Name, Arguments: run.Arguments},
	})
}
