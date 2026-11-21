/**
 * The 409 text for a send whose parent message the server does not hold. The tab
 * matches on it to re-sync and send again once, instead of showing an error.
 * Lives here because a +server.ts may export only request handlers.
 */
export const PARENT_NOT_FOUND_MESSAGE = "This conversation changed. Syncing and sending again.";

/** The 409 text for a send whose proposed message id already exists in the conversation. */
export const MESSAGE_ID_IN_USE_MESSAGE = "Message id in use.";
