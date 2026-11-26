/**
 * When two connector names are "the same" (C169). The model's tool dispatch is keyed by
 * connector name, so two connectors in one turn with one name would let a tool be sent to
 * the wrong one. Names clash when they are equal after trimming, collapsing inner
 * whitespace and case-folding. Used by the server (creating, renaming, resolving a turn)
 * and the browser alike, so they can never disagree.
 */
export function connectorNameKey(name: string): string {
	return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function sameConnectorName(a: string, b: string): boolean {
	return connectorNameKey(a) === connectorNameKey(b);
}

/** The message a refused add or rename shows next to the name field. */
export function connectorNameTaken(name: string): string {
	return `A connector named "${name.trim().replace(/\s+/g, " ")}" already exists. Choose another name.`;
}

/** Thrown by the connector screens' fetch helpers on a 409: the name is taken. */
export class ConnectorNameTakenError extends Error {}
