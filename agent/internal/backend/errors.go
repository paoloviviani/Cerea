package backend

import "errors"

// ErrSessionBusy is returned by a backend whose Prompt cannot run while the
// session is mid-turn (the ACP adapter: a second session/prompt would
// overwrite the turn ids the first one is still streaming under). Backends
// that queue instead — opencode's prompt_async joins the running loop's
// next LLM step — never return it. dispatch.go maps it to the wire code
// "invalid", the same code every other invalid-state refusal carries.
var ErrSessionBusy = errors.New("the session is mid-turn; stop it before sending another prompt")

// ErrCommandNotFound is ResolveCommand's answer for a name the workspace
// listing does not carry — a menu gone stale, never a server error.
// dispatch.go maps it to the wire code "not_found".
var ErrCommandNotFound = errors.New("no such command here")

// ErrAttachmentUnknown is session.attachment's answer for a sha the session
// never listed. dispatch.go maps it to "not_found".
var ErrAttachmentUnknown = errors.New("no such attachment in this session")

// ErrAttachmentGone is its answer for an image that was listed but is no
// longer on the machine (the ACP backend keeps them in memory only; a galopin
// restart loses them). dispatch.go maps it to "not_found".
var ErrAttachmentGone = errors.New("this image is no longer on the machine")
