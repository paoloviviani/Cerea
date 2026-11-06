// pi permission gate for galopin's ACP backend.
//
// pi has no tool permissions and pi-acp never sends session/request_permission
// for a built-in tool. pi-acp does forward an extension's ctx.ui.confirm as one,
// so this extension asks before EVERY tool call. galopin's ACP backend
// (internal/backend/acp, unwrapPiGate) reads the title "pi <tool>" and the JSON
// message {"tool","input"} back into an ordinary read/edit/execute ask, so the
// machine's classes, limits and Plan/Ask/Allow selector apply.
//
// Install: copy to ~/.pi/agent/extensions/ask-gate.ts (the pi home galopin's
// agent runs with). Do not change the title or message shape without changing
// unwrapPiGate and its test.
type GateEvent = { toolName: string; input: unknown };
type GateCtx = {
	hasUI: boolean;
	ui: { confirm(title: string, message: string): Promise<boolean> };
};
type GateApi = {
	on(
		name: "tool_call",
		fn: (event: GateEvent, ctx: GateCtx) => Promise<{ block: true; reason: string } | undefined>
	): void;
};

export default function (pi: GateApi) {
	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.hasUI) return { block: true, reason: "no client to ask" };
		const ok = await ctx.ui.confirm(
			`pi ${event.toolName}`,
			JSON.stringify({ tool: event.toolName, input: event.input })
		);
		return ok ? undefined : { block: true, reason: "Declined by the user" };
	});
}
