package main

import (
	"sort"
	"strings"
	"testing"

	"galopin/internal/backend/opencode"
)

// The MCP route offers exactly the tools the opencode route installs: a tool
// added to one and not the other is a capability that silently depends on
// which agent the person runs.
func TestMCPToolsMatchOpencodeTools(t *testing.T) {
	want := opencode.ToolNames()
	got := make([]string, 0, len(mcpTools))
	for _, tl := range mcpTools {
		got = append(got, tl.Name)
	}
	sort.Strings(want)
	sort.Strings(got)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("MCP tools %v, opencode tools %v", got, want)
	}
}
