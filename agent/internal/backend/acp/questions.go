package acp

// Questions over ACP. ACP has no question message, so an agent asks the person through
// galopin's own MCP tool (ask_user, agenttools_question.go): the call is held here as a
// question.asked card, exactly the shape opencode's built-in question tool raises, and
// returns the person's answers to the agent when they reply (question.reply). The
// backend reports Questions only when the agent has galopin's tools (MCPCapable).

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"
	"time"

	"galopin/internal/backend"
)

// defaultQuestionTimeout is how long a question waits: below the 300 s Vibe gives an MCP
// tool call, so galopin withdraws the card and answers before the agent gives up on it.
const defaultQuestionTimeout = 270 * time.Second

// galopinQuestionPrefix marks a question id galopin minted.
const galopinQuestionPrefix = "gq_"

type pendingQuestion struct {
	sessionID string
	answer    chan questionAnswer
}

type questionAnswer struct {
	answers  [][]string
	rejected bool
}

// AskQuestions implements backend.QuestionHost.
func (b *Backend) AskQuestions(ctx context.Context, workspaceDir, sessionID string, questions []backend.QuestionItem) ([][]string, error) {
	b.tools.mu.Lock()
	for _, other := range b.tools.questions {
		if other.sessionID == sessionID {
			b.tools.mu.Unlock()
			return nil, backend.ErrQuestionPending
		}
	}
	b.tools.mu.Unlock()
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	id := galopinQuestionPrefix + hex.EncodeToString(raw)
	pq := &pendingQuestion{sessionID: sessionID, answer: make(chan questionAnswer, 1)}
	b.tools.mu.Lock()
	for _, other := range b.tools.questions { // re-checked: a second call may have got in
		if other.sessionID == sessionID {
			b.tools.mu.Unlock()
			return nil, backend.ErrQuestionPending
		}
	}
	if b.tools.questions == nil {
		b.tools.questions = map[string]*pendingQuestion{}
	}
	b.tools.questions[id] = pq
	b.tools.mu.Unlock()
	b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventQuestionAsked, QuestionRequestID: id, Questions: questions})
	timeout := b.questionTimeout
	if timeout == 0 {
		timeout = defaultQuestionTimeout
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-timer.C:
		if _, held := b.claimQuestion(id); held {
			b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventQuestionResolved, QuestionRequestID: id, QuestionDecision: "rejected"})
		}
		return nil, backend.ErrQuestionTimeout
	case a := <-pq.answer:
		if a.rejected {
			return nil, backend.ErrQuestionDismissed
		}
		return a.answers, nil
	case <-ctx.Done():
		// the call was aborted (the turn was stopped, the endpoint revoked): withdraw the card
		if _, held := b.claimQuestion(id); held {
			b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventQuestionResolved, QuestionRequestID: id, QuestionDecision: "rejected"})
		}
		return nil, backend.ErrQuestionDismissed
	}
}

// claimQuestion removes and returns a held question, once: a reply or a withdrawal,
// whichever comes first.
func (b *Backend) claimQuestion(id string) (*pendingQuestion, bool) {
	b.tools.mu.Lock()
	defer b.tools.mu.Unlock()
	pq, ok := b.tools.questions[id]
	delete(b.tools.questions, id)
	return pq, ok
}

func (b *Backend) takeQuestion(sessionID, id string) (*pendingQuestion, error) {
	if !strings.HasPrefix(id, galopinQuestionPrefix) {
		return nil, backend.ErrQuestionGone
	}
	pq, ok := b.claimQuestion(id)
	if !ok || pq.sessionID != sessionID {
		if ok { // another session's: put it back, answer nothing
			b.tools.mu.Lock()
			b.tools.questions[id] = pq
			b.tools.mu.Unlock()
		}
		return nil, backend.ErrQuestionGone
	}
	return pq, nil
}

// ReplyQuestion implements backend.Asker: the person's answers, one slice per question.
func (b *Backend) ReplyQuestion(_ context.Context, workspaceDir, sessionID, requestID string, answers [][]string) error {
	pq, err := b.takeQuestion(sessionID, requestID)
	if err != nil {
		return err
	}
	pq.answer <- questionAnswer{answers: answers}
	b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventQuestionResolved, QuestionRequestID: requestID, QuestionDecision: "answered", QuestionAnswers: answers})
	return nil
}

// RejectQuestion implements backend.Asker: the person dismissed it.
func (b *Backend) RejectQuestion(_ context.Context, workspaceDir, sessionID, requestID string) error {
	pq, err := b.takeQuestion(sessionID, requestID)
	if err != nil {
		return err
	}
	pq.answer <- questionAnswer{rejected: true}
	b.emit(workspaceDir, sessionID, backend.Event{Kind: backend.EventQuestionResolved, QuestionRequestID: requestID, QuestionDecision: "rejected"})
	return nil
}

// dismissQuestions ends every question held for a session as dismissed (its turn was
// stopped), so no card is left for a call nobody is waiting on.
func (b *Backend) dismissQuestions(workspaceDir, sessionID string) {
	b.tools.mu.Lock()
	var ids []string
	for id, pq := range b.tools.questions {
		if pq.sessionID == sessionID {
			ids = append(ids, id)
		}
	}
	b.tools.mu.Unlock()
	for _, id := range ids {
		_ = b.RejectQuestion(context.Background(), workspaceDir, sessionID, id)
	}
}

var (
	_ backend.QuestionHost = (*Backend)(nil)
	_ backend.Asker        = (*Backend)(nil)
)

// ownAskUserNames are the exact names the engines give galopin's ask_user MCP tool in an ask
// (goose: "galopin: ask user"; Vibe: "mcp_galopin.ask_user"; others join with underscores).
var ownAskUserNames = map[string]bool{
	"galopin: ask user":    true,
	"galopin__ask_user":    true,
	"galopin_ask_user":     true,
	"mcp_galopin.ask_user": true,
}

// isOwnAskUser reports whether a tool call's ask is for galopin's own ask_user tool of this
// session: the session holds galopin's MCP endpoint (the server named "galopin" in its
// session/new), the call is the catch-all kind with no command and no path (an edit or a shell
// call never is), and its name is exactly one an engine gives that tool. Nothing here is
// fuzzy, and the result is a tag galopin sets, never something the agent's call carries.
func (b *Backend) isOwnAskUser(st *sessionState, call map[string]any) bool {
	st.mu.Lock()
	has := st.mcp != nil
	st.mu.Unlock()
	if !has {
		return false
	}
	if k := getStr(call, "kind"); k != "" && k != "other" {
		return false
	}
	if raw, ok := call["rawInput"].(map[string]any); ok && (getStr(raw, "command") != "" || getStr(raw, "path", "file_path", "filePath") != "") {
		return false
	}
	if locs, ok := call["locations"].([]any); ok && len(locs) > 0 {
		return false
	}
	return ownAskUserNames[getStr(call, "title")] || ownAskUserNames[getStr(call, "name")]
}

// OwnAskUser implements the machine's check of the tag isOwnAskUser set. Only this backend
// sets it (a request from opencode never carries it for the machine to believe).
func (b *Backend) OwnAskUser(req backend.PermissionRequest) bool {
	return req.Metadata["galopinTool"] == "ask_user"
}
