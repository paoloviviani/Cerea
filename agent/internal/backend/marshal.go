package backend

import "encoding/json"

// Wire shapes PROTOCOL.md types as "present, possibly null or empty" where the
// structs' omitempty tags would drop the field. The shared fixtures
// (agent/protocol-fixtures) pin each of them; every method here only adds the
// fields the spec says are always there.

func orNull(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// MarshalJSON writes modeId, modelId, parentId and usage as null when unset
// (PROTOCOL.md §6 "Types": `modeId|null, modelId|null, parentId|null, usage:
// Usage|null`).
func (s Session) MarshalJSON() ([]byte, error) {
	type plain Session
	return json.Marshal(struct {
		plain
		ModeID   *string `json:"modeId"`
		ModelID  *string `json:"modelId"`
		ParentID *string `json:"parentId"`
		Usage    *Usage  `json:"usage"`
	}{plain(s), orNull(s.ModeID), orNull(s.ModelID), orNull(s.ParentID), s.Usage})
}

// MarshalJSON writes patterns and always as arrays and metadata as an object
// when empty (PROTOCOL.md §7: `patterns[], metadata{}, always[]`).
func (r PermissionRequest) MarshalJSON() ([]byte, error) {
	type plain PermissionRequest
	patterns, always, metadata := r.Patterns, r.Always, r.Metadata
	if patterns == nil {
		patterns = []string{}
	}
	if always == nil {
		always = []string{}
	}
	if metadata == nil {
		metadata = map[string]any{}
	}
	return json.Marshal(struct {
		plain
		Patterns []string       `json:"patterns"`
		Metadata map[string]any `json:"metadata"`
		Always   []string       `json:"always"`
	}{plain(r), patterns, metadata, always})
}

// MarshalJSON writes a compaction part's auto flag even when false: a person's
// "Compact now" is `auto: false` (PROTOCOL.md §7: `compaction {auto: bool}`).
func (p Part) MarshalJSON() ([]byte, error) {
	type plain Part
	if p.Type != PartCompaction {
		return json.Marshal(plain(p))
	}
	return json.Marshal(struct {
		plain
		Auto bool `json:"auto"`
	}{plain(p), p.Auto})
}

// MarshalJSON writes options as an array when empty (PROTOCOL.md §7:
// `options: QuestionOption[]`).
func (q QuestionItem) MarshalJSON() ([]byte, error) {
	type plain QuestionItem
	options := q.Options
	if options == nil {
		options = []QuestionOption{}
	}
	return json.Marshal(struct {
		plain
		Options []QuestionOption `json:"options"`
	}{plain(q), options})
}

// MarshalJSON writes origin as null when unknown and hints as an array
// (PROTOCOL.md §6 "Types": `origin: ...|null`, `hints: string[]`, `shell:
// bool|null`).
func (c Command) MarshalJSON() ([]byte, error) {
	type plain Command
	hints := c.Hints
	if hints == nil {
		hints = []string{}
	}
	return json.Marshal(struct {
		plain
		Origin *string  `json:"origin"`
		Hints  []string `json:"hints"`
	}{plain(c), orNull(string(c.Origin)), hints})
}
