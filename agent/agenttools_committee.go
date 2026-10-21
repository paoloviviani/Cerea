package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"galopin/internal/backend"
)

// The committee recipe (PROTOCOL.md §6 "Recipes"): session_committee spawns N
// delegates that answer the same question independently, and galopin hands the
// spawner ONE message with all their answers once every member has reported or
// the timeout has passed. Each member is an ordinary delegate (ADR 0099)
// spawned through the same checks, card and limits as session_spawn: the
// committee is a convenience over spawn, not a second permission path.

const (
	committeeMin = 2
	// committeeMax equals the live-spawn limit per root: a larger committee
	// could never run at once.
	committeeMax            = maxLivePerRoot
	committeeDefaultTimeout = 15 * time.Minute
	committeeMaxTimeout     = 60 * time.Minute
)

// groupMember is one committee member.
type groupMember struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Profile string `json:"profile,omitempty"`
}

// groupRec is one open committee. It persists with the report state, so a
// restart neither loses the answers gathered nor the deadline.
type groupRec struct {
	Spawner  string            `json:"spawner"`
	Title    string            `json:"title"`
	Members  []groupMember     `json:"members"`
	Results  map[string]string `json:"results"` // member session id -> its report text
	Deadline time.Time         `json:"deadline"`
	// Sealed: every member has been spawned (no more will join).
	Sealed bool `json:"sealed"`
}

// complete: every member has been spawned and every one has answered.
func (g *groupRec) complete() bool {
	if !g.Sealed {
		return false
	}
	for _, m := range g.Members {
		if _, ok := g.Results[m.ID]; !ok {
			return false
		}
	}
	return true
}

// joinGroup tags a delegate as a member of a committee.
func (at *agentTools) joinGroup(child, group string) {
	rs := at.reports
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if rec := rs.Delegates[child]; rec != nil {
		rec.Group = group
		rs.saveLocked()
	}
}

// groupAbsorb takes a member's report or failure into its committee. It reports
// false when the item is not the committee's to take: not a member, or an
// approval notice (the spawner should see those at once).
func (at *agentTools) groupAbsorb(item reportItem) bool {
	if item.Kind != "report" && item.Kind != "error" {
		return false
	}
	rs := at.reports
	rs.mu.Lock()
	rec := rs.Delegates[item.Delegate]
	if rec == nil || rec.Group == "" {
		rs.mu.Unlock()
		return false
	}
	gid := rec.Group
	g := rs.Groups[gid]
	if g == nil {
		rec.Group = ""
		rs.mu.Unlock()
		return false
	}
	g.Results[item.Delegate] = item.Text
	done := g.complete()
	rs.saveLocked()
	rs.mu.Unlock()
	if done {
		at.closeGroup(gid, false)
	}
	return true
}

// sealGroup marks every member spawned; a committee already complete closes.
func (at *agentTools) sealGroup(gid string) {
	rs := at.reports
	rs.mu.Lock()
	g := rs.Groups[gid]
	if g == nil {
		rs.mu.Unlock()
		return
	}
	g.Sealed = true
	done := g.complete()
	rs.saveLocked()
	rs.mu.Unlock()
	if done {
		at.closeGroup(gid, false)
	}
}

// closeGroup delivers the committee's answers as one report. Members that have
// not answered are named, not waited for; a late report then arrives on its own
// like any delegate's.
func (at *agentTools) closeGroup(gid string, timedOut bool) {
	rs := at.reports
	rs.mu.Lock()
	g := rs.Groups[gid]
	if g == nil {
		rs.mu.Unlock()
		return
	}
	delete(rs.Groups, gid)
	for _, m := range g.Members {
		if rec := rs.Delegates[m.ID]; rec != nil {
			rec.Group = ""
		}
	}
	rs.saveLocked()
	rs.mu.Unlock()
	if len(g.Members) == 0 {
		return
	}
	var parts []string
	answered := 0
	for _, m := range g.Members {
		if text, ok := g.Results[m.ID]; ok {
			answered++
			parts = append(parts, text)
			continue
		}
		parts = append(parts, fmt.Sprintf("No answer yet from %s (session %s): it was still working when the committee's time ran out. It reports on its own if it finishes; session_read shows what it has so far.", m.Title, m.ID))
	}
	head := fmt.Sprintf("Committee %q: %d of %d members answered.", g.Title, answered, len(g.Members))
	if timedOut {
		head += " The time limit passed."
	}
	text := head + "\n\n" + strings.Join(parts, "\n\n---\n\n")
	at.enqueue(g.Spawner, reportItem{Kind: "report", Delegate: g.Members[0].ID, Title: "committee " + g.Title, Text: text})
}

// armGroup closes the committee at its deadline.
func (at *agentTools) armGroup(gid string, deadline time.Time) {
	d := deadline.Sub(at.now())
	if d < 0 {
		d = 0
	}
	at.afterFunc(d, func() { at.closeGroup(gid, true) })
}

// resumeGroups re-arms the deadlines a previous process left.
func (at *agentTools) resumeGroups() {
	rs := at.reports
	rs.mu.Lock()
	type armed struct {
		id string
		t  time.Time
	}
	var todo []armed
	for id, g := range rs.Groups {
		todo = append(todo, armed{id, g.Deadline})
	}
	rs.mu.Unlock()
	for _, a := range todo {
		at.armGroup(a.id, a.t)
	}
}

// spawnHeadroom refuses a committee that the spawn limits would cut short, so
// it is all-or-nothing: n more live sessions and n more spawns must fit. It
// spends nothing; each member's own spawn does.
func (at *agentTools) spawnHeadroom(ctx context.Context, tc *toolCaller, n int) error {
	marks := at.host.SpawnMarks()
	depth, root := spawnChain(marks, tc.session.ID)
	if depth >= maxSpawnDepth {
		return refuse("spawn chain limit: sessions spawned %d deep cannot spawn further", maxSpawnDepth)
	}
	all, err := at.allSessions(ctx)
	if err != nil {
		return err
	}
	byID := map[string]backend.Session{}
	for _, l := range all {
		byID[l.s.ID] = l.s
	}
	if live := at.liveSpawnedUnder(root, marks, byID); live+n > maxLivePerRoot {
		return refuse("live spawn limit: a committee of %d needs room for %d more sessions but %d are already running under this root (limit %d); wait for one to finish or ask fewer", n, n, live, maxLivePerRoot)
	}
	at.mu.Lock()
	defer at.mu.Unlock()
	at.spawnLog[root] = recent(at.spawnLog[root], at.now(), spawnWindow)
	if len(at.spawnLog[root])+n > spawnsPerWindow {
		return refuse("spawn rate limit: a committee of %d does not fit in the %d spawns per %d minutes", n, spawnsPerWindow, int(spawnWindow.Minutes()))
	}
	return nil
}

func memberBrief(i, n int, question string) string {
	return fmt.Sprintf("You are member %d of %d of a committee: each member answers the same question independently, and the answers are put side by side for the person who asked. "+
		"Do not message the other members and do not read their sessions. Disagreeing with the others is useful: give your own answer, not a hedge toward consensus.\n\n"+
		"Question:\n\n%s\n\n"+
		"Your final message is your answer: your conclusion first, then the key reasons and evidence, and how confident you are.", i, n, question)
}

// committee implements session_committee.
func (at *agentTools) committee(ctx context.Context, tc *toolCaller, call backend.ToolCall) (string, string, error) {
	m, err := decodeObject(call.Args, "the arguments", "title", "question", "profiles", "timeoutMinutes")
	if err != nil {
		return "", "", err
	}
	var title, question string
	if v, ok := m["title"]; ok && json.Unmarshal(v, &title) != nil {
		return "", "", refuse("title must be a string")
	}
	if v, ok := m["question"]; ok && json.Unmarshal(v, &question) != nil {
		return "", "", refuse("question must be a string")
	}
	title = strings.TrimSpace(title)
	if title == "" || len(title) > 120 {
		return "", "", refuse("title is required (at most 120 characters)")
	}
	if strings.TrimSpace(question) == "" {
		return "", "", refuse("question is required")
	}
	if len(question) > maxToolText-1024 {
		return "", "", refuse("question is longer than %d bytes; shorten it or put the detail in a file the members can read", maxToolText-1024)
	}
	var profiles []string
	if v, ok := m["profiles"]; !ok || json.Unmarshal(v, &profiles) != nil {
		return "", "", refuse("profiles is required: a list of %d to %d profile names, one per member (\"\" for none)", committeeMin, committeeMax)
	}
	if len(profiles) < committeeMin || len(profiles) > committeeMax {
		return "", "", refuse("a committee has %d to %d members; got %d", committeeMin, committeeMax, len(profiles))
	}
	timeout := committeeDefaultTimeout
	if v, ok := m["timeoutMinutes"]; ok {
		var mins float64
		if json.Unmarshal(v, &mins) != nil {
			return "", "", refuse("timeoutMinutes must be a number")
		}
		if mins != 0 {
			if mins < 1 || mins > committeeMaxTimeout.Minutes() {
				return "", "", refuse("timeoutMinutes must be between 1 and %d (0 for the default, %d)", int(committeeMaxTimeout.Minutes()), int(committeeDefaultTimeout.Minutes()))
			}
			timeout = time.Duration(mins * float64(time.Minute))
		}
	}
	// Refuse what could never work before anything is started: unknown profiles
	// and limits that would cut the committee short.
	for _, p := range profiles {
		if _, err := at.resolveProfile(p); err != nil {
			return "", "", err
		}
	}
	if err := at.spawnHeadroom(ctx, tc, len(profiles)); err != nil {
		return "", "", err
	}

	rs := at.reports
	gid := fmt.Sprintf("g_%d", at.now().UnixNano())
	deadline := at.now().Add(timeout)
	rs.mu.Lock()
	rs.Groups[gid] = &groupRec{Spawner: tc.session.ID, Title: title, Results: map[string]string{}, Deadline: deadline}
	rs.saveLocked()
	rs.mu.Unlock()

	var started []map[string]string
	var firstID string
	var spawnErr error
	for i, p := range profiles {
		mtitle := fmt.Sprintf("%s (%d/%d)", title, i+1, len(profiles))
		if p = strings.TrimSpace(p); p != "" {
			mtitle = fmt.Sprintf("%s (%d/%d, %s)", title, i+1, len(profiles), p)
		}
		out, childID, err := at.spawnMember(ctx, tc, call, gid, spawnSpec{
			title: mtitle, prompt: memberBrief(i+1, len(profiles), question), profile: p, report: true, group: gid,
		}, groupMember{Title: mtitle, Profile: p})
		if err != nil {
			spawnErr = err
			break
		}
		_ = out
		if firstID == "" {
			firstID = childID
		}
		started = append(started, map[string]string{"sessionId": childID, "title": mtitle})
	}
	if len(started) == 0 {
		rs.mu.Lock()
		delete(rs.Groups, gid)
		rs.saveLocked()
		rs.mu.Unlock()
		return "", "", spawnErr
	}
	at.armGroup(gid, deadline)
	at.sealGroup(gid)
	res := map[string]any{
		"started": started, "timeoutMinutes": int(timeout.Minutes()),
		"note": "the members' answers arrive together in one message headed Committee; do not poll",
	}
	if spawnErr != nil {
		res["notStarted"] = len(profiles) - len(started)
		res["stoppedBecause"] = spawnErr.Error()
	}
	body, _ := json.Marshal(res)
	return string(body), firstID, nil
}

// spawnMember spawns one member and records it in the group the moment its
// session exists (before its first prompt, so its report cannot beat it).
func (at *agentTools) spawnMember(ctx context.Context, tc *toolCaller, call backend.ToolCall, gid string, spec spawnSpec, mem groupMember) (string, string, error) {
	spec.group = gid
	out, childID, err := at.spawnCore(ctx, tc, call, spec)
	if childID != "" {
		// A member whose session exists but whose spawn then failed is owed
		// no answer: it joins only when it was prompted, and its reports go
		// to the spawner on their own.
		if err != nil {
			at.joinGroup(childID, "")
		} else {
			mem.ID = childID
			at.reports.mu.Lock()
			if g := at.reports.Groups[gid]; g != nil {
				g.Members = append(g.Members, mem)
				at.reports.saveLocked()
			}
			at.reports.mu.Unlock()
		}
	}
	return out, childID, err
}
