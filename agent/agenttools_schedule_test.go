package main

import (
	"encoding/json"
	"strings"
	"testing"

	"galopin/internal/permrules"
)

const (
	pA = permrules.Allow
	pK = permrules.Ask
	pD = permrules.Deny
)

// TestScheduleDecisionTable is the whole table of PROTOCOL.md §6 "Schedule
// tools": every tool × the session's word (grant) × scheduled run × self ×
// the ceiling.
func TestScheduleDecisionTable(t *testing.T) {
	want := func(f scheduleFacts) scheduleOutcome {
		switch {
		case f.ceiling == pD:
			return scheduleRefuse
		case f.tool == "schedule_list":
			return scheduleAuto
		case f.machineDeny:
			return scheduleRefuse
		case f.ceiling == pK:
			return scheduleAsk
		case f.tool != "schedule_create" && f.selfStop:
			return scheduleAuto
		case f.grant == pD:
			return scheduleRefuse
		case f.tool == "schedule_create" && f.scheduledRun:
			return scheduleAsk
		case f.tool == "schedule_create" && f.grant == pA:
			return scheduleAuto
		}
		return scheduleAsk
	}
	n := 0
	for _, tool := range []string{"schedule_list", "schedule_create", "schedule_update", "schedule_delete"} {
		for _, ceiling := range []permrules.Action{pA, pK, pD} {
			for _, grant := range []permrules.Action{pA, pK, pD} {
				for _, run := range []bool{false, true} {
					for _, self := range []bool{false, true} {
						for _, machineDeny := range []bool{false, true} {
							f := scheduleFacts{tool: tool, ceiling: ceiling, grant: grant, machineDeny: machineDeny, scheduledRun: run, selfStop: self}
							got, reason := decideSchedule(f)
							if got != want(f) {
								t.Errorf("%+v: got %s (%s), want %s", f, got, reason, want(f))
							}
							if got == scheduleRefuse && reason == "" {
								t.Errorf("%+v: a refusal without a reason", f)
							}
							n++
						}
					}
				}
			}
		}
	}
	// And the spec's sentences, spelled out, so the table above cannot drift
	// into agreeing with a wrong implementation.
	cases := []struct {
		name string
		f    scheduleFacts
		want scheduleOutcome
	}{
		{"Allow covers create", scheduleFacts{tool: "schedule_create", ceiling: pA, grant: pA}, scheduleAuto},
		{"Ask cards create", scheduleFacts{tool: "schedule_create", ceiling: pA, grant: pK}, scheduleAsk},
		{"Deny refuses create", scheduleFacts{tool: "schedule_create", ceiling: pA, grant: pD}, scheduleRefuse},
		{"a scheduled run's create asks even under Allow", scheduleFacts{tool: "schedule_create", ceiling: pA, grant: pA, scheduledRun: true}, scheduleAsk},
		{"self pause under Ask: no card", scheduleFacts{tool: "schedule_update", ceiling: pA, grant: pK, selfStop: true}, scheduleAuto},
		{"self delete under Ask: no card", scheduleFacts{tool: "schedule_delete", ceiling: pA, grant: pK, selfStop: true}, scheduleAuto},
		{"other update under Allow asks", scheduleFacts{tool: "schedule_update", ceiling: pA, grant: pA}, scheduleAsk},
		{"other delete under Allow asks", scheduleFacts{tool: "schedule_delete", ceiling: pA, grant: pA}, scheduleAsk},
		{"ceiling ask beats self pause", scheduleFacts{tool: "schedule_update", ceiling: pK, grant: pA, selfStop: true}, scheduleAsk},
		{"ceiling ask beats Allow create", scheduleFacts{tool: "schedule_create", ceiling: pK, grant: pA}, scheduleAsk},
		{"ceiling deny beats self delete", scheduleFacts{tool: "schedule_delete", ceiling: pD, grant: pA, selfStop: true}, scheduleRefuse},
		{"ceiling deny refuses list", scheduleFacts{tool: "schedule_list", ceiling: pD}, scheduleRefuse},
		{"self pause under the session's Deny: no card", scheduleFacts{tool: "schedule_update", ceiling: pA, grant: pD, selfStop: true}, scheduleAuto},
		{"self delete under the session's Deny: no card", scheduleFacts{tool: "schedule_delete", ceiling: pA, grant: pD, selfStop: true}, scheduleAuto},
		{"other update under the session's Deny: refused", scheduleFacts{tool: "schedule_update", ceiling: pA, grant: pD}, scheduleRefuse},
		{"a machine deny refuses self pause", scheduleFacts{tool: "schedule_update", ceiling: pA, grant: pA, machineDeny: true, selfStop: true}, scheduleRefuse},
		{"a machine deny refuses self delete", scheduleFacts{tool: "schedule_delete", ceiling: pA, grant: pD, machineDeny: true, selfStop: true}, scheduleRefuse},
		{"ceiling ask cards a self pause under Deny", scheduleFacts{tool: "schedule_update", ceiling: pK, grant: pD, selfStop: true}, scheduleAsk},
		{"list under Deny asks nothing", scheduleFacts{tool: "schedule_list", ceiling: pA, grant: pD}, scheduleAuto},
	}
	for _, c := range cases {
		if got, _ := decideSchedule(c.f); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
	if n != 4*3*3*2*2*2 {
		t.Fatalf("covered %d rows", n)
	}
}

// TestScheduleGrantComposed reads `schedule` out of rules composed the way a
// real session gets them: the blanket Allow covers it (unlike the session_*
// tools), Ask and Deny are the session's word, the machine's own rule beats
// the blanket (re-appended after it), and the ceiling caps everything.
func TestScheduleGrantComposed(t *testing.T) {
	agent := []permrules.Rule{{Permission: "*", Pattern: "*", Action: pA}} // opencode's default build agent
	cases := []struct {
		mode    permrules.Action
		own     map[string]permrules.Action
		ceiling map[string]permrules.Action
		want    permrules.Action
	}{
		{pA, nil, nil, pA},
		{pK, nil, nil, pK},
		{pD, nil, nil, pD},
		{pK, map[string]permrules.Action{"schedule": pA}, nil, pA},
		{pA, map[string]permrules.Action{"schedule": pK}, nil, pK},
		{pA, map[string]permrules.Action{"schedule": pD}, nil, pD},
		{pD, map[string]permrules.Action{"schedule": pA}, nil, pD},
		{pA, nil, map[string]permrules.Action{"schedule": pK}, pK},
		{pA, nil, map[string]permrules.Action{"schedule": pD}, pD},
		{pK, map[string]permrules.Action{"schedule": pA}, map[string]permrules.Action{"schedule": pK}, pK},
		// A grant of the coordination tools says nothing about schedules.
		{pK, map[string]permrules.Action{"session_spawn": pA}, nil, pK},
	}
	for _, c := range cases {
		l := permrules.Layers{Own: permrules.OwnRules(c.own), Ceiling: permrules.Ceiling{Max: c.ceiling}}
		rules := append(append([]permrules.Rule(nil), agent...), permrules.Compose(l, permrules.Selector{Mode: c.mode}, agent)...)
		if got := scheduleGrantFrom(rules, c.mode); got != c.want {
			t.Errorf("mode %s own %v ceiling %v: got %s, want %s", c.mode, c.own, c.ceiling, got, c.want)
		}
	}
	// Uncomposed rules (opencode's bare default) under Ask are not consent.
	if got := scheduleGrantFrom(agent, pK); got != pK {
		t.Errorf("bare `*: allow` under Ask = %s, want ask", got)
	}
}

// earlyRefusal refuses only what the full facts would refuse: under the
// session's Deny an update/delete waits for self (it may be a run stopping
// itself), a create does not.
func TestScheduleEarlyRefusal(t *testing.T) {
	if earlyRefusal(scheduleFacts{tool: "schedule_delete", ceiling: pA, grant: pD}) != nil {
		t.Error("a delete under Deny was refused before knowing whether it is the caller's own")
	}
	if earlyRefusal(scheduleFacts{tool: "schedule_create", ceiling: pA, grant: pD}) == nil {
		t.Error("a create under Deny must be refused before Cerea is asked")
	}
	if earlyRefusal(scheduleFacts{tool: "schedule_update", ceiling: pA, grant: pA, machineDeny: true}) == nil {
		t.Error("a machine deny must refuse before Cerea is asked")
	}
}

func TestScheduleArgsDecoding(t *testing.T) {
	m, err := decodeObject([]byte(`{"name":"n","prompt":"p","recurrence":{"type":"daily","at":"09:00"},"timezone":"","workspaceId":"","session":"this","permissionMode":"ask","coordination":[]}`),
		"the arguments", "name", "prompt", "recurrence", "timezone", "workspaceId", "session", "permissionMode", "coordination")
	if err != nil {
		t.Fatal(err)
	}
	f, err := readFields(m)
	if err != nil {
		t.Fatal(err)
	}
	if f.Timezone != nil || f.WorkspaceID != nil {
		t.Fatalf("\"\" must read as not given: %+v", f)
	}
	if *f.Session != "this" || string(*f.Recurrence) != `{"type":"daily","at":"09:00"}` {
		t.Fatalf("fields: %+v", f)
	}
	for _, bad := range []string{
		`{"permissionMode":"yolo"}`, `{"agentMode":"general"}`, `{"session":"other"}`, `{"recurrence":"daily"}`, `{"paused":"yes"}`,
		`{"coordination":"session_list"}`, `{"name":` + mustJSON(strings.Repeat("x", 201)) + `}`,
	} {
		m, err := decodeObject([]byte(bad), "x", "name", "permissionMode", "agentMode", "session", "recurrence", "paused", "coordination")
		if err == nil {
			_, err = readFields(m)
		}
		if err == nil {
			t.Errorf("%s: accepted", bad)
		}
	}
	if _, err := decodeObject([]byte(`{"deviceId":"other"}`), "the arguments", "name"); err == nil {
		t.Error("an unknown key (another device) must be refused, not ignored")
	}
}

func TestDescribeRecurrence(t *testing.T) {
	for in, want := range map[string]string{
		`{"type":"hours","every":1}`:             "every hour",
		`{"type":"hours","every":6}`:             "every 6 hours",
		`{"type":"daily","at":"09:00"}`:          "every day at 09:00",
		`{"type":"weekdays","at":"08:30"}`:       "weekdays at 08:30",
		`{"type":"weekly","day":1,"at":"10:00"}`: "every Monday at 10:00",
		`{"type":"weekly","day":0,"at":"10:00"}`: "every Sunday at 10:00",
		`{"type":"cron","expr":"0 9 * * 1-5"}`:   "cron 0 9 * * 1-5",
	} {
		if got := describeRecurrence(json.RawMessage(in)); got != want {
			t.Errorf("%s: %q, want %q", in, got, want)
		}
	}

}
