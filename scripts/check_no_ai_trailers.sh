#!/bin/sh
# Rejects a commit (or merge) message that carries AI attribution: this
# repository's history names its human authors only (MAINTAINING.md, rule 1).
# Called with the path of a file holding one message (the .husky/commit-msg
# hook) or many messages separated by "--- commit <sha> ---" lines (the
# ci.yml backstop, which sees every commit whatever the local hook state).
if grep -qiE 'Co-Authored-By:.*(claude|anthropic|openai|gpt|gemini|copilot)|Claude-Session:|claude\.ai/code|noreply@anthropic\.com|Generated with \[?(Claude|opencode)' "$1"; then
	echo "commit-msg: AI attribution (a co-author trailer, session link or 'Generated with' line) is not allowed in this repository; remove it." >&2
	exit 1
fi
