// Package mcpfake is a tiny stdio MCP server for tests: a test binary
// re-executes itself as one (see the TestMain or init that calls Run when
// MCPFAKE_SERVER=1). Test support only: nothing outside *_test.go imports it.
//
// Tools: read_file, write_file and boom (its result is an error). MCPFAKE_MODE
// changes its behaviour: "crash" (exit 3 on a tools/call, "kaboom" on
// stderr), "exit-at-once" (exit 1 with an ENOENT line at start) and "big" (a
// 2 MiB tools/call result). The text of a tools/call result ends with
// $FAKE_VALUE.
package mcpfake

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// Enabled reports whether this process is to run as the fake server.
func Enabled() bool { return os.Getenv("MCPFAKE_SERVER") == "1" }

func Run() {
	mode := os.Getenv("MCPFAKE_MODE")
	if mode == "exit-at-once" {
		fmt.Fprintln(os.Stderr, "Error: ENOENT: no such file or directory")
		os.Exit(1)
	}
	fmt.Fprintln(os.Stderr, "fake server up")
	in := bufio.NewReaderSize(os.Stdin, 1<<20)
	out := os.Stdout
	reply := func(id json.RawMessage, result any) {
		b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
		fmt.Fprintf(out, "%s\n", b)
	}
	for {
		line, err := in.ReadBytes('\n')
		if err != nil {
			return
		}
		handle := func(m json.RawMessage) {
			var r struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
				Params struct {
					Name string `json:"name"`
				} `json:"params"`
			}
			if json.Unmarshal(m, &r) != nil || len(r.ID) == 0 {
				return
			}
			switch r.Method {
			case "initialize":
				reply(r.ID, map[string]any{"protocolVersion": "2025-03-26", "capabilities": map[string]any{"tools": map[string]any{}},
					"serverInfo": map[string]any{"name": "fake", "version": "1"}})
			case "tools/list":
				tools := []map[string]any{}
				for _, n := range []string{"read_file", "write_file", "boom"} {
					tools = append(tools, map[string]any{"name": n, "inputSchema": map[string]any{"type": "object"}})
				}
				reply(r.ID, map[string]any{"tools": tools, "extra": "kept"})
			case "tools/call":
				switch {
				case mode == "crash":
					fmt.Fprintln(os.Stderr, "kaboom")
					os.Exit(3)
				case mode == "big":
					reply(r.ID, map[string]any{"content": []map[string]any{{"type": "text", "text": strings.Repeat("x", 2<<20)}}})
				case r.Params.Name == "boom":
					reply(r.ID, map[string]any{"content": []any{}, "isError": true})
				default:
					reply(r.ID, map[string]any{"content": []map[string]any{{"type": "text", "text": "called " + r.Params.Name + " " + os.Getenv("FAKE_VALUE")}}, "isError": false})
				}
			default:
				reply(r.ID, map[string]any{})
			}
		}
		line = []byte(strings.TrimSpace(string(line)))
		if len(line) > 0 && line[0] == '[' {
			var arr []json.RawMessage
			_ = json.Unmarshal(line, &arr)
			for _, m := range arr {
				handle(m)
			}
		} else {
			handle(line)
		}
	}
}
