#!/bin/sh
# Rejects a commit (or merge) message that carries AI attribution other than
# Claude's: a Claude co-author trailer and session link are allowed, any other
# AI or tool attribution is not (MAINTAINING.md, rule 1).
# Called with the path of a file holding one message (the .husky/commit-msg
# hook) or many messages separated by "--- commit <sha> ---" lines (the
# ci.yml backstop, which sees every commit whatever the local hook state).
if grep -qiE 'Co-Authored-By:.*(openai|gpt|gemini|copilot|opencode)|Generated with \[?opencode' "$1"; then
	echo "commit-msg: AI attribution other than Claude's (a co-author trailer or 'Generated with' line) is not allowed in this repository; remove it." >&2
	exit 1
fi
