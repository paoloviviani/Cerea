//go:build !unix

package mcpconn

func lockFile(string) (func(), error) { return func() {}, nil }
