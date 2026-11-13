//go:build !unix

// Package procreap: see the unix build. Nothing to do elsewhere.
package procreap

import "os/exec"

func Init(string) []int { return nil }
func Track(*exec.Cmd)   {}
