package filediff

import (
	"regexp"
	"strings"
)

// EditTool reports whether an opencode tool name changes files.
func EditTool(name string) bool {
	switch strings.ToLower(name) {
	case "edit", "write", "multiedit", "patch", "apply_patch":
		return true
	}
	return false
}

var patchFileRe = regexp.MustCompile(`(?m)^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$`)

// InputPaths are the files an edit call's input names: its file path
// arguments, and for a patch the files its patch text touches.
func InputPaths(input map[string]any) []string {
	var out []string
	for _, k := range []string{"filePath", "file_path", "filepath", "path", "file", "target_file"} {
		if s, ok := input[k].(string); ok && strings.TrimSpace(s) != "" {
			out = append(out, s)
		}
	}
	for _, k := range []string{"patchText", "patch", "input"} {
		if s, ok := input[k].(string); ok {
			for _, m := range patchFileRe.FindAllStringSubmatch(s, -1) {
				out = append(out, m[1])
			}
		}
	}
	return out
}
