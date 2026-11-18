import { buildSubtree } from "./buildSubtree";
import type { Tree, TreeId, TreeNode } from "./tree";

/**
 * The messages a retry of the assistant message `messageId` is answered from:
 * its ancestors, the branch down to the question, and nothing of the attempt
 * being replaced. A failed turn's partial text, tool calls and code runs live
 * in that message, so leaving it out is what keeps a retry from replaying the
 * failed attempt to the model. The new answer is a sibling, so only the
 * active branch is ever read.
 */
export function promptForRetry<T>(conv: Tree<T>, messageId: TreeId): TreeNode<T>[] {
	const branch = buildSubtree(conv, messageId);
	branch.pop();
	return branch;
}
