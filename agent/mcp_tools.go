package main

import (
	"encoding/json"

	"galopin/internal/mcpserve"
)

// The tools the MCP server offers: the same eight as the opencode route, with
// the same argument names and limits (the handlers parse and refuse; the
// schemas here only tell the model the shape). Descriptions are kept in step
// with internal/backend/opencode/tools.go by hand.

const mcpRecurrenceSchema = `{"type":"object","description":"When it runs, one of: {\"type\":\"hours\",\"every\":N} (every N elapsed hours, 1 to 720); {\"type\":\"daily\",\"at\":\"HH:MM\"}; {\"type\":\"weekdays\",\"at\":\"HH:MM\"} (Monday to Friday); {\"type\":\"weekly\",\"day\":D,\"at\":\"HH:MM\"} (D: 0 Sunday to 6 Saturday); {\"type\":\"cron\",\"expr\":\"m h dom mon dow\"} (five fields, or @daily/@hourly). Times are 24-hour wall clock in the timezone. Runs must be at least 15 minutes apart.",` +
	`"properties":{"type":{"type":"string","enum":["hours","daily","weekdays","weekly","cron"]},"every":{"type":"number"},"at":{"type":"string"},"day":{"type":"number"},"expr":{"type":"string"}},"required":["type"]}`

var mcpTools = []mcpserve.Tool{
	{
		Name:        "session_list",
		Description: "List the other coding sessions on this machine (id, title, workspace, mode, status) so you can address one with session_read or session_send. Read-only.",
		Schema:      json.RawMessage(`{"type":"object","properties":{"note":{"type":"string","description":"Anything, e.g. why you are listing. Ignored."}}}`),
	},
	{
		Name: "session_read",
		Description: "Read another session's recent text (by id from session_list): its last user and assistant messages, oldest first, with role and time; no tool output or reasoning. " +
			"A session you spawned is readable with no card; any other asks the person unless this machine's rules allow it. Not for yourself. You do not need it to collect a spawned session's result: that is reported to you.",
		Schema: json.RawMessage(`{"type":"object","properties":{"target":{"type":"string","description":"The session id to read, from session_list."},` +
			`"last":{"type":"number","description":"How many recent messages: 1 to 50 (0 for the default, 10)."}},"required":["target"]}`),
	},
	{
		Name: "session_spawn",
		Description: "Hand work to a NEW top-level session in this workspace (the person can open it and talk to it). Write the prompt as a full briefing: it cannot see this conversation. " +
			"It reports back: when it finishes, its final message arrives in this session as a message from galopin; you are also told if it fails or waits for the person's approval. Do not poll. Pass report:false for fire-and-forget. " +
			"It uses your model and your mode (or \"plan\", read-only), and never more permission than you have. Limits apply (depth, live sessions, rate).",
		Schema: json.RawMessage(`{"type":"object","properties":{"title":{"type":"string","description":"Short title for the new session."},` +
			`"prompt":{"type":"string","description":"The first prompt: everything the new session needs, it cannot see this conversation."},` +
			`"mode":{"type":"string","description":"The new session's mode: \"plan\", \"build\", or \"inherit\" for your own."},` +
			`"report":{"type":"boolean","description":"Default true: its result is delivered to you. false for fire-and-forget."}},"required":["title","prompt"]}`),
	},
	{
		Name: "session_send",
		Description: "Send a message to ANOTHER session (by id from session_list); it arrives as a prompt marked as coming from you, folded into its running turn if it is busy. " +
			"Between you and a session you spawned (either way) it needs no card; any other session asks the person unless this machine's rules allow it. Not for your own subagents or yourself. Limits apply (hops, rate).",
		Schema: json.RawMessage(`{"type":"object","properties":{"target":{"type":"string","description":"The target session id, from session_list."},` +
			`"text":{"type":"string","description":"The message."}},"required":["target","text"]}`),
	},
	{
		Name:        "schedule_list",
		Description: "List this machine's scheduled actions (the person's schedules that run a prompt in a session here): id, name, timetable, timezone, paused, status, next and last run, workspace, session, mode, coordination grant, who created it, and self (true when you are a run of that schedule). Read-only; asks nothing. Use it before creating one, so you update an existing schedule instead of duplicating it.",
		Schema:      json.RawMessage(`{"type":"object","properties":{"note":{"type":"string","description":"Anything, e.g. why you are listing. Ignored."}}}`),
	},
	{
		Name: "schedule_create",
		Description: "Create a scheduled action: a prompt Cerea runs on this machine on a timetable, long after this session ends. " +
			"It follows this session's Deny / Ask / Allow like other tools (Ask shows the person a card with the whole schedule, prompt included; Deny refuses); when you are yourself a scheduled run, every create asks the person. " +
			"The schedule's mode can be no looser than yours, its coordination no wider than yours; at most 5 active agent-created schedules per machine, runs at least 15 minutes apart. Name it clearly: the person will see it in their Schedules list. " +
			"Pass \"\" for a string you want defaulted and [] for no coordination.",
		Schema: json.RawMessage(`{"type":"object","properties":{"name":{"type":"string","description":"Short, clear name: what it does and why (it outlives you)."},` +
			`"prompt":{"type":"string","description":"What each run is told: everything it needs, a run cannot see this conversation."},` +
			`"recurrence":` + mcpRecurrenceSchema + `,` +
			`"timezone":{"type":"string","description":"IANA timezone such as Europe/Rome; \"\" for the person's saved timezone (else UTC)."},` +
			`"workspaceId":{"type":"string","description":"Workspace id to run in; \"\" for this session's workspace."},` +
			`"session":{"type":"string","description":"\"this\" to run each time as a new prompt in this session, \"new\" for a fresh session per run."},` +
			`"permissionMode":{"type":"string","description":"The runs' permission mode: \"deny\", \"ask\" or \"allow\"; no looser than yours."},` +
			`"agentMode":{"type":"string","description":"The runs' agent: \"build\" (can edit; the default for \"\") or \"plan\" (read-only)."},` +
			`"coordination":{"type":"array","items":{"type":"string"},"description":"Coordination tools the runs may use without a card, within your own grant; [] for none. Two options only: session_list, session_read and session_send TOGETHER (all three or none), and session_spawn on its own."}},` +
			`"required":["name","prompt","recurrence"]}`),
	},
	{
		Name:        "schedule_update",
		Description: "Change one of this machine's schedules (id from schedule_list). Pausing or deleting a schedule you are a run of (self:true) goes through without a card, whatever this session's mode: do that when its job is done. Any other change asks the person (and this session's Deny refuses it).",
		Schema: json.RawMessage(`{"type":"object","properties":{"id":{"type":"string","description":"The schedule id, from schedule_list."},` +
			`"changes":{"type":"object","description":"Only the fields to change. {\"paused\":true} pauses it, {\"paused\":false} resumes it.","properties":{` +
			`"name":{"type":"string"},"prompt":{"type":"string"},"recurrence":` + mcpRecurrenceSchema + `,` +
			`"timezone":{"type":"string"},"workspaceId":{"type":"string"},"permissionMode":{"type":"string","enum":["deny","ask","allow"]},` +
			`"agentMode":{"type":"string","enum":["plan","build"]},` +
			`"coordination":{"type":"array","items":{"type":"string"},"description":"The whole new set: session_list+session_read+session_send together or not at all, session_spawn on its own."},"paused":{"type":"boolean"}}}},` +
			`"required":["id","changes"]}`),
	},
	{
		Name:        "schedule_delete",
		Description: "Delete one of this machine's schedules (id from schedule_list). Deleting a schedule you are a run of (self:true) goes through without a card, whatever this session's mode; deleting any other asks the person (and this session's Deny refuses it).",
		Schema:      json.RawMessage(`{"type":"object","properties":{"id":{"type":"string","description":"The schedule id, from schedule_list."}},"required":["id"]}`),
	},
}
