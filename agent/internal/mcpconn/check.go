package mcpconn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// CheckResult is what `galopin connectors test` found.
type CheckResult struct {
	ServerName    string
	ServerVersion string
	Protocol      string
	Tools         []string // as the machine offers them: after allowedTools
}

// Check starts the named server, initializes it, lists its tools and stops
// it, through the same channel path Cerea's traffic takes (ceiling included).
func Check(ctx context.Context, cfg Config, name string) (*CheckResult, error) {
	in := make(chan []byte, 16)
	cfg.Send = func(_ string, m []byte) error { in <- m; return nil }
	closed := make(chan string, 1)
	cfg.Closed = func(_ string, reason string, detail *string) {
		d := ""
		if detail != nil {
			d = ": " + *detail
		}
		closed <- reason + d
	}
	cfg.Audit = func(string, string, string) {}
	h := New(cfg)
	id, oerr := h.Open(ctx, name)
	if oerr != nil {
		return nil, oerr
	}
	defer h.Shutdown()

	call := func(reqID int, method, params string) (json.RawMessage, error) {
		body := fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":%q,"params":%s}`, reqID, method, params)
		h.Message(id, []byte(body))
		timeout := time.After(60 * time.Second)
		for {
			select {
			case m := <-in:
				var r struct {
					ID     int             `json:"id"`
					Method string          `json:"method"`
					Result json.RawMessage `json:"result"`
					Error  *struct {
						Message string `json:"message"`
					} `json:"error"`
				}
				if json.Unmarshal(m, &r) != nil || r.Method != "" || r.ID != reqID {
					continue
				}
				if r.Error != nil {
					return nil, errors.New(r.Error.Message)
				}
				return r.Result, nil
			case why := <-closed:
				return nil, fmt.Errorf("the server closed the channel (%s)", why)
			case <-timeout:
				return nil, fmt.Errorf("%s: no answer within 60 s", method)
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
	}

	res, err := call(1, "initialize", `{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"galopin","version":"test"}}`)
	if err != nil {
		return nil, fmt.Errorf("initialize: %w", err)
	}
	var init struct {
		ProtocolVersion string `json:"protocolVersion"`
		ServerInfo      struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"serverInfo"`
	}
	_ = json.Unmarshal(res, &init)
	h.Message(id, []byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	out := &CheckResult{ServerName: init.ServerInfo.Name, ServerVersion: init.ServerInfo.Version, Protocol: init.ProtocolVersion}

	cursor := ""
	for page := 0; page < 20; page++ {
		params := `{}`
		if cursor != "" {
			b, _ := json.Marshal(map[string]string{"cursor": cursor})
			params = string(b)
		}
		res, err = call(2+page, "tools/list", params)
		if err != nil {
			return out, fmt.Errorf("tools/list: %w", err)
		}
		var list struct {
			Tools      []struct{ Name string } `json:"tools"`
			NextCursor string                  `json:"nextCursor"`
		}
		_ = json.Unmarshal(res, &list)
		for _, t := range list.Tools {
			out.Tools = append(out.Tools, t.Name)
		}
		if list.NextCursor == "" {
			break
		}
		cursor = list.NextCursor
	}
	return out, nil
}
