/**
 * The artifact versions the owner deleted in the open conversation (C122), as the keys the
 * server records on the conversation (`artifactVersionKey`, `fileVersionKey`). Set from the
 * conversation's load data and by "Delete older versions" itself; the registries read it to
 * flag a version as deleted, so a card that pointed at one shows "This version was deleted".
 */
class PrunedVersionsStore {
	#keys = $state<ReadonlySet<string>>(new Set());

	get all(): ReadonlySet<string> {
		return this.#keys;
	}

	set(keys: readonly string[] | undefined): void {
		this.#keys = new Set(keys ?? []);
	}
}

export const prunedVersions = new PrunedVersionsStore();
