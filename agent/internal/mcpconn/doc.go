// Package mcpconn serves the MCP servers configured on this machine to
// Cerea (PROTOCOL.md §10, ADR 0102): the mcp.json format, one channel per
// open (a stdio process or an HTTP session) with raw JSON-RPC passed through
// unchanged, the machine's allowedTools ceiling, the lifecycle (idle close,
// crash, config change) and the OAuth sign-in for http servers.
//
// The transports are written by hand rather than on the MCP Go SDK: galopin
// only passes messages through, byte for byte and batches included, and the
// SDK's client transports decode into typed messages (dropping fields it does
// not know, refusing batches) and own the session and reconnect logic this
// package must control itself.
package mcpconn
