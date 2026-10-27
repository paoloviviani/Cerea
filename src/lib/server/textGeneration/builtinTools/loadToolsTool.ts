import type { TurnConnector } from "$lib/server/mcp/turnConnectors";
import type { BuiltinTool } from "./types";

export const LOAD_TOOLS_TOOL_NAME = "load_tools";

/** What loading one connector came to. */
export type LoadReport =
	| { name: string; status: "loaded"; tools: string[] }
	| { name: string; status: "already"; tools: string[] }
	| { name: string; status: "unknown" }
	| { name: string; status: "switched off" }
	| { name: string; status: "needs sign-in" }
	| { name: string; status: "unavailable"; reason: string };

/**
 * The turn's connectors as the tool sees them (`connectorRuntime.ts`).
 * `version` goes up whenever tools were added, so a nested agent knows to
 * re-read the list.
 */
export interface ConnectorRuntime {
	readonly version: number;
	load(names: string[]): Promise<LoadReport[]>;
}

const MAX_NAMES_IN_LINE = 12;

/**
 * The assistant's list of connectors it can load (ADR 0104): one line each,
 * with its name, a sentence and its tool names. Every connector that is on
 * and not "always loaded" is listed, **loaded or not**, so the text does not
 * change from one turn to the next as connectors get loaded, and the start of
 * the request stays the same for prompt caching.
 */
export function connectorCatalogNotice(connectors: TurnConnector[]): string {
	const lines = connectors
		.filter((c) => !c.alwaysLoaded)
		.map((c) => {
			const names = c.toolNames.slice(0, MAX_NAMES_IN_LINE).join(", ");
			const more = c.toolNames.length > MAX_NAMES_IN_LINE ? ", ..." : "";
			return `- ${c.name}: ${c.summary}${names ? ` Tools: ${names}${more}.` : ""}`;
		});
	if (lines.length === 0) return "";
	return [
		"CONNECTORS YOU CAN LOAD: these services are available, but their tools are not loaded yet.",
		`When the request needs one, call ${LOAD_TOOLS_TOOL_NAME} with its name, then use its tools. Load only what the request needs; once loaded, a connector stays loaded in this conversation.`,
		...lines,
	].join("\n");
}

function describe(report: LoadReport): string {
	switch (report.status) {
		case "loaded":
			return `Loaded ${report.name}. Its tools are available from now on: ${report.tools.join(", ") || "none listed"}.`;
		case "already":
			return `${report.name} is already loaded: ${report.tools.join(", ") || "no tools listed"}.`;
		case "unknown":
			return `${report.name}: no connector with that name is available.`;
		case "switched off":
			return `${report.name}: the person has switched it off. Tell them they can turn it on under Workspace, Connectors.`;
		case "needs sign-in":
			return `${report.name}: the person needs to sign in to it first, under Workspace, Connectors.`;
		case "unavailable":
			return `${report.name}: could not be loaded (${report.reason}).`;
	}
}

export function createLoadToolsBuiltin(runtime: ConnectorRuntime): BuiltinTool {
	return {
		name: LOAD_TOOLS_TOOL_NAME,
		exemptFromToolRestraint: true,
		definition: {
			type: "function",
			function: {
				name: LOAD_TOOLS_TOOL_NAME,
				description:
					"Load the tools of connectors from the list of connectors you can load, so you can call them from your next step. Use the connector's name exactly as listed.",
				parameters: {
					type: "object",
					properties: {
						connectors: {
							type: "array",
							items: { type: "string" },
							description: "Names of the connectors to load.",
						},
					},
					required: ["connectors"],
				},
			},
		},
		async execute(args) {
			const raw = args.connectors;
			const names = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [])
				.filter((n): n is string => typeof n === "string")
				.map((n) => n.trim())
				.filter(Boolean);
			if (names.length === 0) {
				return { error: "Give the names of the connectors to load, as listed." };
			}
			const reports = await runtime.load(names);
			return { resultText: reports.map(describe).join("\n") };
		},
	};
}
