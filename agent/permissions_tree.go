package main

import (
	"context"
	"time"

	"galopin/internal/backend"
	"galopin/internal/decide"
)

// askTreeWait bounds how long an ask from a session whose place in the tree is
// not known is held while its record is read.
const askTreeWait = 5 * time.Second

// maxTreeDepth is how many records are read to place one session.
const maxTreeDepth = 8

// A subagent is decided by its root's word, and the root is only known once the
// tree edge is. The edge normally arrives with the child's session event, ahead
// of its first ask; when it has not (galopin restarted, the event stream was
// cut, an event came late) the child would read as a root on the default Ask and
// its first ask would show a card under an Allow root. An ask from a session
// whose root the materializer has not seen is therefore held: its record (and its
// parents') is read off the event path, then the ask is decided as any other. A
// record that cannot be read within the bound leaves the session a root, which
// fails toward a card.

// decideHeldAsk decides an ask the pre-filter held, once the tree is learned:
// reject and once are answered, a card is let through to the person.
func (mc *machine) decideHeldAsk(dir string, req backend.PermissionRequest) {
	mc.learnTree(dir, req.SessionID)
	rh, ok := mc.ruleHost()
	if !ok {
		mc.mat.ReleaseAsk(context.Background(), dir, req)
		return
	}
	res := mc.decideAsk(rh, dir, req)
	if res.Verdict == decide.Card {
		mc.mat.ReleaseAsk(context.Background(), dir, req)
		return
	}
	mc.mat.DropHeld(req.ID)
	mc.answerAsk(dir, req, res)
}

// learnTree reads the records that place a session in the tree, up to its top,
// within the bound. One caller per session reads; the others wait for it.
func (mc *machine) learnTree(dir, id string) {
	mc.treeMu.Lock()
	if ch, busy := mc.treeBusy[id]; busy {
		mc.treeMu.Unlock()
		<-ch
		return
	}
	if mc.treeBusy == nil {
		mc.treeBusy = map[string]chan struct{}{}
	}
	done := make(chan struct{})
	mc.treeBusy[id] = done
	wait := mc.treeWait
	mc.treeMu.Unlock()
	defer func() {
		mc.treeMu.Lock()
		delete(mc.treeBusy, id)
		mc.treeMu.Unlock()
		close(done)
	}()
	if wait <= 0 {
		wait = askTreeWait
	}
	deadline := time.Now().Add(wait)
	for depth := 0; depth < maxTreeDepth && !mc.mat.TreeKnown(id); depth++ {
		top := mc.mat.RootOf(id)
		// only the asking session is known to live in dir: a parent's own events
		// say where it lives
		recDir := ""
		if top == id {
			recDir = dir
		}
		if !mc.readRecord(recDir, top, deadline) {
			logf("permissions: could not place session %s in the session tree within %s; its asks are decided as a top-level session's", top, wait)
			mc.mat.MarkTreeKnown(dir, id)
			return
		}
	}
	if !mc.mat.TreeKnown(id) {
		// a chain deeper than the cap: settle it too, so the session's later asks are not held again
		logf("permissions: session %s sits deeper in the session tree than %d levels; its asks are decided as a top-level session's", id, maxTreeDepth)
		mc.mat.MarkTreeKnown(dir, id)
	}
}

// readRecord reads one session's record into the materializer, retrying until
// deadline. False when it could not be read.
func (mc *machine) readRecord(dir, id string, deadline time.Time) bool {
	for {
		ctx, cancel := context.WithDeadline(context.Background(), deadline)
		s, err := mc.back.GetSession(ctx, dir, id)
		cancel()
		if err == nil {
			s.ID = id
			mc.mat.Track(dir, s)
			return true
		}
		if !time.Now().Add(200 * time.Millisecond).Before(deadline) {
			return false
		}
		time.Sleep(200 * time.Millisecond)
	}
}
