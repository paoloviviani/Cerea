/**
 * Defaults-vs-state for web search.
 *
 * Settings hold *defaults*, a chat holds *per-chat state*: new chats inherit
 * the defaults, and nothing done inside a chat ever writes back to them.
 *
 * Precedence chain (settled): per-chat state > project defaults (when in a
 * project) > app settings / workspace defaults > off.
 */
export function resolveWebSearchEnabled(options: {
	/** Per-chat state (`Conversation.webSearch`). `undefined` means "not set in this chat". */
	conversationWebSearch?: boolean;
	/** Project default (`Project.defaultWebSearch`). `undefined` means the project leaves it unset. */
	projectDefault?: boolean;
	/** App default (`Settings.webSearchEnabled`). Absent means off. */
	settingsEnabled?: boolean;
}): boolean {
	if (typeof options.conversationWebSearch === "boolean") return options.conversationWebSearch;
	if (typeof options.projectDefault === "boolean") return options.projectDefault;
	return options.settingsEnabled === true;
}
