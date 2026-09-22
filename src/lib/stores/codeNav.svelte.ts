/**
 * The sidebar's list is one surface with two contents: the chats tree and
 * the coding-agents tree, switched by the control at the foot of the list.
 * The state lives in a module, not a component, because the sidebar is
 * mounted twice — the desktop rail and the mobile drawer — and the switch
 * must read the same in both.
 *
 * The open agent's title rides along because the mobile top bar names the
 * screen it is on, and the layout knows the route but not the agent.
 */
export const codeNav = $state({
	view: "chats" as "chats" | "agents",
	agentTitle: "",
});
