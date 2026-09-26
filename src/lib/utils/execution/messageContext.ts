import { getContext, setContext } from "svelte";
import type { PersistedDeliverableRef } from "$lib/types/ParkedCall";

/**
 * What a code block needs to know about the message it sits in, to keep the
 * files its run produces: which conversation and message, whether this view
 * may write (the owner's own conversation, not a share or a read-only view),
 * and the files already stored for a given run, for a replayed block.
 *
 * A context rather than props, because a block is rendered several layers
 * down through the markdown renderer, which has no business knowing about
 * messages.
 */
export interface MessageRunContext {
	conversationId: string | undefined;
	messageId: string;
	canPersist: boolean;
	/** The latest stored files of this run on this message, if any. */
	storedFiles(runKey: string): PersistedDeliverableRef[] | undefined;
}

/** Exported for component tests, which provide the context directly. */
export const MESSAGE_RUN_CONTEXT = Symbol("cerea.messageRun");

export function setMessageRunContext(context: MessageRunContext): void {
	setContext(MESSAGE_RUN_CONTEXT, context);
}

export function getMessageRunContext(): MessageRunContext | undefined {
	return getContext<MessageRunContext | undefined>(MESSAGE_RUN_CONTEXT);
}
