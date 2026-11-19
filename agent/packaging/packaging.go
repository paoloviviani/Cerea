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

//go:embed goose-version
var gooseVersion string

// GooseVersion is the goose release galopin supports as an engine (ADR 0110),
// from the goose-version file; goose-sha256 beside it records the archives'
// checksums, which upstream does not publish. Written only by bump-goose.sh.
func GooseVersion() string { return strings.TrimSpace(gooseVersion) }

//go:embed vibe-version
var vibeVersion string

// VibeVersion is the Mistral Vibe release galopin supports as an engine, from the
// vibe-version file; vibe-requirements.txt beside it pins every dependency by hash
// (pip's --require-hashes format). Written only by bump-vibe.sh.
func VibeVersion() string { return strings.TrimSpace(vibeVersion) }

//go:embed galopin.service
var systemdUnit string

// SystemdUnit is the user unit galopin.service, the template `galopin service
// install` renders (and the file a manual install copies).
func SystemdUnit() string { return systemdUnit }

//go:embed org.cerea.galopin.plist
var launchdPlist string

// LaunchdPlist is the LaunchAgent org.cerea.galopin.plist, the template
// `galopin service install` renders (and the file a manual install copies).
func LaunchdPlist() string { return launchdPlist }
