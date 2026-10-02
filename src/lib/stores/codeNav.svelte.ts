import { onCodeReauth } from "$lib/stores/codeReauth.svelte";

/**
 * The sidebar's list is one surface with two contents: the chats tree and
 * the coding-agents tree, switched by the control at the foot of the list.
 * The state lives in a module, not a component, because the sidebar is
 * mounted twice — the desktop rail and the mobile drawer — and the switch
 * must read the same in both.
 *
 * `view` starts "auto": nothing has picked a side yet, so the sidebar
 * follows the route (agents on `/code`, chats everywhere else) — see
 * NavMenu's `effectiveView`. The moment the switch is clicked, or a `/code`
 * empty state's "Open Agents panel" button fires, `view` becomes an explicit
 * "chats"/"agents" and the route stops driving it for the rest of the tab's
 * life. A hard reload re-imports this module and starts "auto" again, which
 * is what makes a freshly loaded agent link open on Agents without one
 * client-side write racing the SSR render of a concurrent request.
 *
 * The open agent's title rides along because the mobile top bar names the
 * screen it is on, and the layout knows the route but not the agent.
 */
export const codeNav = $state({
	view: "auto" as "auto" | "chats" | "agents",
	agentTitle: "",
});

// The open agent's title is machine-derived: a stale sign-in forgets it.
onCodeReauth(() => {
	codeNav.agentTitle = "";
});
