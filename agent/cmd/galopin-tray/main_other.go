//go:build !darwin

// Command galopin-tray is the macOS menu-bar app ("Cerea connector"). It is
// built for macOS only; this stub keeps `go build ./...` working elsewhere.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "galopin-tray runs on macOS only")
	os.Exit(1)
}
