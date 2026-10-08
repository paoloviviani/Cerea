package link

import (
	"context"
	"encoding/json"
	"strconv"
	"time"
)

// Machine calls (PROTOCOL.md §5 "Machine calls"): the one M→C request. galopin
// sends {"type":"call","id","op",…} and Cerea answers with a callres frame of
// the same id. Only sent while the link is up and paired; a call never
// answered ends after CallTimeout as unavailable, which is also what a Cerea
// that predates calls produces (it ignores the unknown frame type).

// Call is one call's payload; the link adds type and id.
type Call struct {
	Op            string `json:"op"`
	SessionID     string `json:"sessionId"`
	RootSessionID string `json:"rootSessionId"`
	Caller        any    `json:"caller"`
	Args          any    `json:"args"`
}

type callResult struct {
	result json.RawMessage
	err    *OpError
}

// unavailable is the error every call that never reached an answer ends with.
func unavailable(message string) *OpError {
	return &OpError{Code: "unavailable", Message: message}
}

// Supports reports whether the connected Cerea's welcome listed family (e.g.
// "schedule") in features.machineCalls.
func (l *Link) Supports(family string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, f := range l.machineCalls {
		if f == family {
			return true
		}
	}
	return false
}

// Call sends one call and waits for its callres, ctx's end, the connection's
// end or CallTimeout, whichever comes first. The result is the callres's
// result object on success.
func (l *Link) Call(ctx context.Context, c Call) (json.RawMessage, *OpError) {
	l.mu.Lock()
	if l.sched == nil || l.connCtx == nil {
		l.mu.Unlock()
		return nil, unavailable("Cerea is not reachable from this machine right now")
	}
	if !l.paired {
		l.mu.Unlock()
		return nil, unavailable("this machine is not paired with Cerea yet")
	}
	l.callSeq++
	id := "c" + strconv.FormatUint(l.callSeq, 10)
	ch := make(chan callResult, 1)
	l.pending[id] = ch
	connCtx := l.connCtx
	l.mu.Unlock()
	drop := func() {
		l.mu.Lock()
		delete(l.pending, id)
		l.mu.Unlock()
	}
	if c.Args == nil {
		c.Args = map[string]any{}
	}
	err := l.writeFrame(connCtx, map[string]any{
		"type": "call", "id": id, "op": c.Op, "sessionId": c.SessionID,
		"rootSessionId": c.RootSessionID, "caller": c.Caller, "args": c.Args,
	})
	if err != nil {
		drop()
		return nil, unavailable("Cerea is not reachable from this machine right now")
	}
	timer := time.NewTimer(l.cfg.CallTimeout)
	defer timer.Stop()
	select {
	case r := <-ch:
		return r.result, r.err
	case <-timer.C:
		drop()
		return nil, unavailable("Cerea did not answer in time")
	case <-ctx.Done():
		drop()
		return nil, unavailable("the call was cancelled before Cerea answered")
	}
}

// handleCallRes delivers a callres to its waiter. An id nobody waits for (a
// call that already timed out, or one this process never made) is dropped.
func (l *Link) handleCallRes(raw []byte) {
	var res struct {
		ID     string          `json:"id"`
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &res) != nil || res.ID == "" {
		return
	}
	l.mu.Lock()
	ch, ok := l.pending[res.ID]
	delete(l.pending, res.ID)
	l.mu.Unlock()
	if !ok {
		return
	}
	switch {
	case res.OK:
		if len(res.Result) == 0 {
			res.Result = json.RawMessage("{}")
		}
		ch <- callResult{result: res.Result}
	case res.Error != nil && res.Error.Code != "":
		ch <- callResult{err: &OpError{Code: res.Error.Code, Message: res.Error.Message}}
	default:
		ch <- callResult{err: &OpError{Code: "unavailable", Message: "Cerea answered without a result or an error"}}
	}
}

// failPending ends every waiting call: the connection that would have
// carried their answers is gone.
func (l *Link) failPending(message string) {
	l.mu.Lock()
	waiting := l.pending
	l.pending = map[string]chan callResult{}
	l.mu.Unlock()
	for _, ch := range waiting {
		ch <- callResult{err: unavailable(message)}
	}
}
