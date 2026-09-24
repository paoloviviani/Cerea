package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// legacyFileNames maps every file enroll/run/serve used to write beside
// opencode's own config (each name prefixed pystino- there to avoid
// colliding with opencode's own files in that shared directory) to the name
// it carries now, in its own defaultStateDir with no need for the prefix.
var legacyFileNames = map[string]string{
	"pystino-credentials.json": credentialsFileName,
	"pystino-status.json":      statusFileName,
	"policy.json":              policyFileName,
	"machine-id":               machineIDFileName,
	"revoked":                  revokedMarkerFileName,
	"opencode-overlay.json":    "opencode-overlay.json",
	"workspaces.json":          "workspaces.json",
}

// migrationDisabled reports whether an explicit --creds or --state-dir means
// migrateLegacyState must not run: either one is the operator naming their
// own layout, which an automatic migration must never second-guess. serve
// and enroll have no --state-dir flag, so they always pass "" for it.
func migrationDisabled(credsFlag, stateDirFlag string) bool {
	return credsFlag != "" || stateDirFlag != ""
}

// migrateLegacyState moves a pre-galopin install's state into defaultStateDir,
// the first time run/enroll/serve resolves --creds (and, for run,
// --state-dir) at their defaults — an explicit flag means the caller has its
// own layout in mind, and callers only reach this when neither was given.
//
// If defaultStateDir already has its own credentials, it wins outright:
// nothing is read from the legacy directory and nothing there is
// overwritten. Otherwise every legacy file that exists is moved (atomic
// rename, falling back to copy+remove across filesystems) preserving its
// mode, and one line names what moved.
func migrateLegacyState() error {
	newDir, err := defaultStateDir()
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(newDir, credentialsFileName)); err == nil {
		return nil
	}
	oldDir, err := legacyStateDir()
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(oldDir, "pystino-credentials.json")); err != nil {
		return nil
	}
	if err := os.MkdirAll(newDir, 0o700); err != nil {
		return fmt.Errorf("creating %s: %w", newDir, err)
	}

	var moved []string
	for oldName, newName := range legacyFileNames {
		oldPath := filepath.Join(oldDir, oldName)
		info, statErr := os.Stat(oldPath)
		if statErr != nil {
			continue
		}
		newPath := filepath.Join(newDir, newName)
		if err := renameOrCopy(oldPath, newPath, info.Mode()); err != nil {
			return fmt.Errorf("migrating %s: %w", oldName, err)
		}
		moved = append(moved, newName)
	}
	if len(moved) > 0 {
		sort.Strings(moved)
		fmt.Fprintf(os.Stderr, "galopin: migrated %s from %s to %s\n",
			strings.Join(moved, ", "), oldDir, newDir)
	}
	return nil
}

// renameOrCopy moves oldPath to newPath. os.Rename is atomic and preserves
// mode for free when both paths share a filesystem, which is the common
// case here (both under the same config dir); the copy fallback applies
// mode explicitly so a cross-filesystem config dir still keeps 0600/0700.
func renameOrCopy(oldPath, newPath string, mode os.FileMode) error {
	if err := os.Rename(oldPath, newPath); err == nil {
		return nil
	}
	body, err := os.ReadFile(oldPath)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(newPath, body, mode); err != nil {
		return err
	}
	return os.Remove(oldPath)
}
