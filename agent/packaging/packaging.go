// Package packaging carries the files under agent/packaging that the binary
// itself needs. A go:embed pattern cannot reach outside its own package
// directory, so the pinned opencode release lives here, next to the scripts
// that read it, and the opencode backend imports it from this package.
package packaging

import (
	_ "embed"
	"strings"
)

//go:embed opencode-version
var opencodeVersion string

// OpencodeVersion is the opencode release galopin is built and tested
// against, from the opencode-version file (the one place it is written; the
// panel's install line and CI read the same file).
func OpencodeVersion() string { return strings.TrimSpace(opencodeVersion) }
