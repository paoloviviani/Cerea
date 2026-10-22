/**
 * Public share links are gone from the product, but rows made by older
 * versions may still sit in the `sharedConversations` collection, and their
 * copied attachments in the chat bucket (tagged `metadata.conversation` with
 * the share's 7-character id). Nothing reads them any more and nothing
 * creates them; the data is never dropped on upgrade.
 *
 * What still needs the rows is cleanup: deleting a conversation deletes the
 * old links made from it, erasing an account deletes the person's links, and
 * the orphan sweep keeps telling a live share copy from a dead one. They go
 * through the raw collection, with no type and no index.
 */
import type { Collection, Document } from "mongodb";

import { Database } from "$lib/server/database";

export const LEGACY_SHARES_COLLECTION = "sharedConversations";

export async function legacyShares(): Promise<Collection<Document>> {
	return (await Database.getInstance()).rawCollection(LEGACY_SHARES_COLLECTION);
}
