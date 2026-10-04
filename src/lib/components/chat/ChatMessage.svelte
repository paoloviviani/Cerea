<script lang="ts">
	import { base } from "$app/paths";
	import { goto } from "$app/navigation";
	import type { Message } from "$lib/types/Message";
	import { tick } from "svelte";

	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	const publicConfig = usePublicConfig();
	import CopyToClipBoardBtn from "../CopyToClipBoardBtn.svelte";
	import IconLoading from "../icons/IconLoading.svelte";
	import CarbonRotate360 from "~icons/carbon/rotate-360";
	// import CarbonDownload from "~icons/carbon/download";

	import CarbonPen from "~icons/carbon/pen";
	import CarbonCopy from "~icons/carbon/copy";
	import CarbonCheckmark from "~icons/carbon/checkmark";
	import UploadedFile from "./UploadedFile.svelte";

	import MarkdownRenderer from "./MarkdownRenderer.svelte";
	import OpenReasoningResults from "./OpenReasoningResults.svelte";
	import Alternatives from "./Alternatives.svelte";
	import MessageAvatar from "./MessageAvatar.svelte";
	import { PROVIDERS_HUB_ORGS } from "@huggingface/inference";
	import { requireAuthUser } from "$lib/utils/auth";
	import ToolUpdate from "./ToolUpdate.svelte";
	import TurnWaitBanner from "./TurnWaitBanner.svelte";
	import { turnStateOf } from "$lib/utils/generationState";
	import ToolCallsSummary from "./ToolCallsSummary.svelte";
	import ArtifactCard from "./ArtifactCard.svelte";
	import ElicitationForm from "./ElicitationForm.svelte";
	import ToolApprovalCard from "./ToolApprovalCard.svelte";
	import LucideBot from "~icons/lucide/bot";
	import { getCodeSessionLinks } from "$lib/utils/codeSessionLinks";
	import CodeExecutionCard from "./CodeExecutionCard.svelte";
	import PlanCard from "./PlanCard.svelte";
	import MemoryCard from "./MemoryCard.svelte";
	import BackgroundTaskCard from "./BackgroundTaskCard.svelte";
	import {
		isMessageToolUpdate,
		isMessageToolResultUpdate,
		isMessageToolErrorUpdate,
		isMessageElicitationRequestUpdate,
		isMessageElicitationResolvedUpdate,
		isMessageCodeExecutionRequestUpdate,
		isMessageCodeExecutionResolvedUpdate,
		isMessagePlanUpdate,
		isMessageMemoryUpdate,
		isMessageBackgroundTaskUpdate,
	} from "$lib/utils/messageUpdates";
	import {
		MessageUpdateType,
		MessageToolUpdateType,
		MessageCodeExecutionUpdateType,
		type MessageCodeExecutionOutputsUpdate,
		type MessageToolUpdate,
		type MessageElicitationResolvedUpdate,
		type MessageCodeExecutionRequestUpdate,
		type MessageCodeExecutionResolvedUpdate,
		type MessagePlanUpdate,
		type MessageMemoryUpdate,
		type MessageBackgroundTaskUpdate,
	} from "$lib/types/MessageUpdate";
	import type { ElicitationAction, ElicitationRequestPayload } from "$lib/types/McpElicitation";
	import type { CodeSubagentAnchor } from "$lib/types/CodeAgent";
	import type { Snippet } from "svelte";
	import { page } from "$app/state";
	import { setMessageRunContext } from "$lib/utils/execution/messageContext";
	import { runFiles } from "$lib/stores/runFiles.svelte";
	import ImageLightbox from "./ImageLightbox.svelte";
	import CollapsibleUserText from "./CollapsibleUserText.svelte";
	import { splitArtifactSegments, stripArtifacts } from "$lib/utils/artifacts";
	import type { ArtifactOperation } from "$lib/utils/artifacts";

	interface Props {
		message: Message;
		loading?: boolean;
		isAuthor?: boolean;
		readOnly?: boolean;
		isTapped?: boolean;
		alternatives?: Message["id"][];
		editMsdgId?: Message["id"] | null;
		isLast?: boolean;
		/**
		 * Regenerate / edit-with-content, when the caller owns a message tree to
		 * retry against. Surfaces whose messages are a replay of someone else's
		 * log (the coding-agent transcript) omit it, and the affordances that
		 * mutate the tree — retry, edit — are not offered.
		 */
		onretry?: (payload: { id: Message["id"]; content?: string }) => void;
		onshowAlternateMsg?: (payload: { id: Message["id"] }) => void;
		/**
		 * Pluggable answer path for approval cards: when set, the agent-style
		 * approval (see ToolApprovalCard) answers through it instead of the
		 * conversation elicitation endpoint. Absent on chat routes, where the
		 * conversation id picks the channel.
		 */
		onanswerElicitation?: (
			request: ElicitationRequestPayload,
			action: ElicitationAction,
			/** Set only for the approval card's "Always allow" button. */
			scope?: "always"
		) => Promise<{ ok: boolean; error?: string }>;
		/**
		 * The coding-agent panel's subagent claim: when a tool call id names a
		 * subagent (the roster the panel polls on turn boundaries, or — before
		 * that pairing — a spawn tool call), the generic tool card gives way to
		 * the panel's subagent card, exactly as a Plan or Memory update
		 * supersedes the call that produced it. The card itself is the caller's
		 * snippet, so chat stays decoupled from the panel; without these props
		 * the transcript renders as it always has.
		 */
		subagentFor?: (callId: string) => CodeSubagentAnchor | undefined;
		subagentCard?: Snippet<[CodeSubagentAnchor]>;
		/**
		 * Where the person's own attachments are served from (`UploadedFile`'s
		 * `fileBaseUrl`) — for a surface whose page path is not a
		 * conversation's. Unset, chat's page-relative `…/output` is used.
		 */
		fileBaseUrl?: string;
		/**
		 * Extra per-message actions in the assistant footer, next to Copy and
		 * Retry — the coding-agent panel's "Hand off…" (see `AgentView`). Shown
		 * only once the message's own turn is done, the same "completed"
		 * reading `turnStateOf` already gives the rest of this footer. Absent,
		 * the footer is exactly what it always was; chat itself stays unchanged.
		 */
		messageActions?: Snippet<[Message]>;
		/**
		 * Elicitation/question/wait-banner channel id, for a surface whose page
		 * path is not a conversation's (the coding-agent panel's agent id) — the
		 * user-question tool's registration key (`pendingQuestion`'s store) is
		 * this same id, so a panel passing its agent id here is what lets that
		 * card find the right agent instead of every one sharing chat's route
		 * fallback. Unset, chat's own `page.params.id` is used, as always.
		 */
		conversationId?: string;
	}

	let {
		message,
		loading = false,
		isAuthor = true,
		readOnly = false,
		isTapped = $bindable(false),
		alternatives = [],
		editMsdgId = $bindable(null),
		isLast = false,
		onretry,
		onshowAlternateMsg,
		onanswerElicitation,
		subagentFor,
		subagentCard,
		fileBaseUrl,
		messageActions,
		conversationId,
	}: Props = $props();

	const sessionLinks = getCodeSessionLinks();
	const convId = $derived(conversationId ?? page.params.id ?? "");

	// What a code block in this message needs to keep the files its run
	// produces. Writing is for the owner's own chat page only: never a share,
	// a read-only view, or the /code agent transcript (which reuses this
	// component for somebody else's log).
	setMessageRunContext({
		get conversationId() {
			return convId || undefined;
		},
		get messageId() {
			return message.id;
		},
		get canPersist() {
			return (
				message.from === "assistant" &&
				isAuthor &&
				!readOnly &&
				(page.route.id ?? "").startsWith("/conversation/[id]") &&
				// While this message is still generating it carries a client-minted
				// id the server hasn't saved yet (see the run-files route's 409):
				// any record made now would just be refused. Not required for
				// correctness — CodeBlock's claim retries once the id swaps to the
				// server's — but skipping the doomed attempt avoids the round trip
				// and the noise of a request that can only ever fail.
				!(isLast && loading)
			);
		},
		storedFiles(runKey: string) {
			const stored = [...(message.updates ?? []), ...runFiles.for(message.id)].filter(
				(u) =>
					u.type === MessageUpdateType.CodeExecution &&
					u.subtype === MessageCodeExecutionUpdateType.Outputs &&
					u.runKey === runKey
			) as MessageCodeExecutionOutputsUpdate[];
			return stored.at(-1)?.files;
		},
	});

	let contentEl: HTMLElement | undefined = $state();
	let isCopied = $state(false);
	let isUserMsgCopied = $state(false);
	let userCopyTimeout: ReturnType<typeof setTimeout>;
	let messageWidth: number = $state(0);
	let messageInfoWidth: number = $state(0);
	let lightboxSrc: string | null = $state(null);

	function handleContentClick(e: MouseEvent) {
		const target = e.target as HTMLElement;
		if (target.tagName === "IMG" && target instanceof HTMLImageElement) {
			e.preventDefault();
			e.stopPropagation();
			lightboxSrc = target.src;
		}
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			editFormEl?.requestSubmit();
		}
		if (e.key === "Escape") {
			editMsdgId = null;
		}
	}

	function handleCopy(event: ClipboardEvent) {
		if (!contentEl) return;

		const selection = window.getSelection();
		if (!selection || selection.isCollapsed) return;
		if (!selection.anchorNode || !selection.focusNode) return;

		const anchorInside = contentEl.contains(selection.anchorNode);
		const focusInside = contentEl.contains(selection.focusNode);
		if (!anchorInside && !focusInside) return;

		if (!event.clipboardData) return;

		const range = selection.getRangeAt(0);
		const wrapper = document.createElement("div");
		wrapper.appendChild(range.cloneContents());

		wrapper.querySelectorAll("[data-exclude-from-copy]").forEach((el) => {
			el.remove();
		});

		wrapper.querySelectorAll("*").forEach((el) => {
			el.removeAttribute("style");
			el.removeAttribute("class");
			el.removeAttribute("color");
			el.removeAttribute("bgcolor");
			el.removeAttribute("background");

			for (const attr of Array.from(el.attributes)) {
				if (attr.name === "id" || attr.name.startsWith("data-")) {
					el.removeAttribute(attr.name);
				}
			}
		});

		const html = wrapper.innerHTML;
		const text = wrapper.textContent ?? "";

		event.preventDefault();
		event.clipboardData.setData("text/html", html);
		event.clipboardData.setData("text/plain", text);
	}

	let editContentEl: HTMLTextAreaElement | undefined = $state();
	let editFormEl: HTMLFormElement | undefined = $state();

	// Zero-config reasoning autodetection: detect <think> blocks in content
	const THINK_BLOCK_REGEX = /(<think>[\s\S]*?(?:<\/think>|$))/gi;

	// Strip think blocks and artifact tags for clipboard copy (always, regardless of detection)
	let contentWithoutThink = $derived.by(() =>
		stripArtifacts(message.content.replace(THINK_BLOCK_REGEX, "")).trim()
	);

	type ElicitationBlock = {
		type: "elicitation";
		request: ElicitationRequestPayload;
		expiresAt?: number;
		resolved?: MessageElicitationResolvedUpdate;
	};

	type CodeExecutionBlock = {
		type: "codeExecution";
		request: MessageCodeExecutionRequestUpdate;
		resolved?: MessageCodeExecutionResolvedUpdate;
	};

	type Block =
		| { type: "text"; content: string }
		| { type: "think"; content: string; closed: boolean }
		| { type: "tool"; uuid: string; updates: MessageToolUpdate[] }
		| { type: "artifact"; op: ArtifactOperation; opIndex: number }
		| ElicitationBlock
		| CodeExecutionBlock
		| { type: "plan"; update: MessagePlanUpdate }
		| { type: "memory"; update: MessageMemoryUpdate }
		| { type: "backgroundTask"; update: MessageBackgroundTaskUpdate }
		| {
				type: "subagent";
				uuid: string;
				anchor: CodeSubagentAnchor;
				/** The call's frames, kept so a reverted card can give them back. */
				updates: MessageToolUpdate[];
		  };

	type ToolBlock = Extract<Block, { type: "tool" }>;
	type ProcessBlock = Extract<Block, { type: "think" } | { type: "tool" }>;

	type RenderUnit =
		| { kind: "text"; content: string }
		| { kind: "group"; blocks: ProcessBlock[]; toolCount: number }
		| { kind: "artifact"; op: ArtifactOperation; opIndex: number }
		| ({ kind: "elicitation" } & Omit<ElicitationBlock, "type">)
		| ({ kind: "codeExecution" } & Omit<CodeExecutionBlock, "type">)
		| { kind: "plan"; update: MessagePlanUpdate }
		| { kind: "memory"; update: MessageMemoryUpdate }
		| { kind: "backgroundTask"; update: MessageBackgroundTaskUpdate }
		| { kind: "subagent"; uuid: string; anchor: CodeSubagentAnchor; updates: MessageToolUpdate[] };

	// Expand any text block containing <think>…</think> into dedicated think blocks
	// so reasoning can be grouped/collapsed separately from the answer text.
	function expandThinkBlocks(input: Block[]): Block[] {
		const out: Block[] = [];
		for (const block of input) {
			if (block.type !== "text") {
				out.push(block);
				continue;
			}
			for (const part of block.content.split(THINK_BLOCK_REGEX)) {
				if (!part) continue;
				if (part.startsWith("<think>")) {
					const closed = part.endsWith("</think>");
					out.push({ type: "think", content: part.slice(7, closed ? -8 : undefined), closed });
				} else if (part.trim().length > 0) {
					out.push({ type: "text", content: part });
				}
			}
		}
		return out;
	}

	// Replace inline <artifact> blocks in text with dedicated artifact blocks that
	// render as cards (content lives in the artifact panel). Streaming-safe:
	// partially received tags are hidden until complete.
	function expandArtifactBlocks(input: Block[]): Block[] {
		const out: Block[] = [];
		let opIndex = 0;
		for (const block of input) {
			if (block.type !== "text") {
				out.push(block);
				continue;
			}
			for (const segment of splitArtifactSegments(block.content)) {
				if (segment.type === "artifact") {
					out.push({ type: "artifact", op: segment.op, opIndex: opIndex++ });
				} else if (segment.content.length > 0) {
					out.push({ type: "text", content: segment.content });
				}
			}
		}
		return collapseConsecutiveArtifactOps(out);
	}

	// Models sometimes emit several back-to-back operations on the same artifact
	// (e.g. one update block per find/replace pair). Every op still becomes a
	// version in the registry, but showing a card per op clutters the chat —
	// keep only the last card of each consecutive run.
	function collapseConsecutiveArtifactOps(input: Block[]): Block[] {
		const out: Block[] = [];
		for (const block of input) {
			if (block.type === "artifact") {
				let i = out.length - 1;
				while (i >= 0) {
					const prior = out[i];
					if (prior.type === "text" && prior.content.trim().length === 0) {
						i -= 1;
						continue;
					}
					if (prior.type === "artifact" && prior.op.identifier === block.op.identifier) {
						// Drop the earlier card (and the whitespace between) — this
						// later op supersedes it.
						out.splice(i, out.length - i);
					}
					break;
				}
			}
			out.push(block);
		}
		return out;
	}

	// The live turn's park, rendered as a countdown from its ABSOLUTE deadline
	// (clock-skew corrected). Only the last message of the conversation can be
	// parked; earlier messages' turnState events are history, not liveness.
	let waitingState = $derived.by(() => {
		if (!isLast) return undefined;
		const state = turnStateOf(message);
		return state?.state === "waiting" && state.until !== undefined ? state : undefined;
	});

	let blocks = $derived.by(() => {
		const updates = message.updates ?? [];
		const res: Block[] = [];
		const hasTools = updates.some(isMessageToolUpdate);
		let contentCursor = 0;
		let sawFinalAnswer = false;

		// Fast path: no tool updates at all
		if (!hasTools && updates.length === 0) {
			return expandArtifactBlocks(
				expandThinkBlocks(
					message.content ? [{ type: "text" as const, content: message.content }] : []
				)
			);
		}

		for (const update of updates) {
			if (update.type === MessageUpdateType.Stream) {
				const token =
					typeof update.token === "string" && update.token.length > 0 ? update.token : null;
				const len = token !== null ? token.length : (update.len ?? 0);
				const chunk =
					token ??
					(message.content ? message.content.slice(contentCursor, contentCursor + len) : "");
				contentCursor += len;
				if (!chunk) continue;
				const last = res.at(-1);
				if (last?.type === "text") last.content += chunk;
				else res.push({ type: "text" as const, content: chunk });
			} else if (isMessageToolUpdate(update)) {
				// The panel's subagent claim, decided per frame — the roster can
				// pair (or unname) a call between commits, and the builder reruns
				// from scratch, so the decision must be a pure function of the
				// frames seen so far:
				// - a call frame with a claim becomes the dedicated subagent card,
				//   and the generic tool card never forms for that uuid;
				// - a closing frame keeps the card only while the polled roster
				//   backs it — a call that closed unpaired gives the row back to
				//   the generic card, so a spawn the daemon never tracked does not
				//   read as a subagent stuck running forever.
				if (subagentFor) {
					const anchor = subagentFor(update.uuid);
					const subagentBlock = res.find(
						(b): b is Extract<Block, { type: "subagent" }> =>
							b.type === "subagent" && b.uuid === update.uuid
					);
					if (update.subtype === MessageToolUpdateType.Call) {
						if (anchor) {
							if (subagentBlock) {
								subagentBlock.anchor = anchor;
								subagentBlock.updates.push(update);
							} else {
								res.push({
									type: "subagent" as const,
									uuid: update.uuid,
									anchor,
									updates: [update],
								});
							}
							continue;
						}
					} else if (subagentBlock) {
						if (anchor?.subagent) {
							subagentBlock.updates.push(update);
							continue;
						}
						// Closed without a polled record: the row goes back to the
						// generic card, with every frame it swallowed.
						res.splice(res.indexOf(subagentBlock), 1);
						res.push({
							type: "tool" as const,
							uuid: update.uuid,
							updates: [...subagentBlock.updates, update],
						});
						continue;
					} else if (anchor?.subagent) {
						res.push({
							type: "subagent" as const,
							uuid: update.uuid,
							anchor,
							updates: [update],
						});
						continue;
					}
				}
				const existingBlock = res.find(
					(b): b is ToolBlock => b.type === "tool" && b.uuid === update.uuid
				);
				if (existingBlock) {
					existingBlock.updates.push(update);
				} else {
					res.push({ type: "tool" as const, uuid: update.uuid, updates: [update] });
				}
			} else if (isMessageElicitationRequestUpdate(update)) {
				res.push({
					type: "elicitation" as const,
					request: update.request,
					expiresAt: update.expiresAt,
				});
			} else if (isMessageElicitationResolvedUpdate(update)) {
				// Settles the existing block rather than adding one.
				const target = res.find(
					(b): b is ElicitationBlock =>
						b.type === "elicitation" && b.request.elicitationId === update.elicitationId
				);
				if (target) target.resolved = update;
			} else if (isMessageCodeExecutionRequestUpdate(update)) {
				res.push({
					type: "codeExecution" as const,
					request: update,
				});
			} else if (isMessageCodeExecutionResolvedUpdate(update)) {
				// Settles the existing card rather than adding one.
				const codeTarget = res.find(
					(b): b is CodeExecutionBlock =>
						b.type === "codeExecution" && b.request.executionId === update.executionId
				);
				if (codeTarget) codeTarget.resolved = update;
			} else if (isMessagePlanUpdate(update)) {
				// One live card per message: a later update supersedes the earlier card and
				// takes its stream position, and the generic tool card for the same call
				// gives way to the dedicated one (a failed call emits no Plan update, so
				// its error card survives).
				const toolIdx = res.findIndex((b) => b.type === "tool" && b.uuid === update.uuid);
				if (toolIdx !== -1) res.splice(toolIdx, 1);
				const planIdx = res.findIndex((b) => b.type === "plan");
				if (planIdx !== -1) res.splice(planIdx, 1);
				res.push({ type: "plan", update });
			} else if (isMessageMemoryUpdate(update)) {
				// Unlike a plan, memory writes accumulate: two facts remembered in
				// one turn are two things that happened and two things to undo,
				// so each keeps its own card. The generic tool card for the same
				// call gives way to it, exactly as the plan's does.
				const memoryToolIdx = res.findIndex((b) => b.type === "tool" && b.uuid === update.uuid);
				if (memoryToolIdx !== -1) res.splice(memoryToolIdx, 1);
				res.push({ type: "memory", update });
			} else if (isMessageBackgroundTaskUpdate(update)) {
				// A background subagent's marker accumulates like memory, never
				// folded: each child keeps its own row, and the generic tool
				// card for the spawning call stays — the marker names the
				// lifecycle, the tool card the call.
				res.push({ type: "backgroundTask", update });
			} else if (update.type === MessageUpdateType.FinalAnswer) {
				sawFinalAnswer = true;
				const finalText = update.text ?? "";
				const currentText = res
					.filter((b) => b.type === "text")
					.map((b) => (b as { type: "text"; content: string }).content)
					.join("");

				let addedText = "";
				if (finalText.startsWith(currentText)) {
					addedText = finalText.slice(currentText.length);
				} else if (!currentText.endsWith(finalText)) {
					const needsGap = !/\n\n$/.test(currentText) && !/^\n/.test(finalText);
					addedText = (needsGap ? "\n\n" : "") + finalText;
				}

				if (addedText) {
					const last = res.at(-1);
					if (last?.type === "text") {
						last.content += addedText;
					} else {
						res.push({ type: "text" as const, content: addedText });
					}
				}
			}
		}

		// If content remains unmatched (e.g., persisted stream markers), append the remainder
		// Skip when a FinalAnswer already provided the authoritative text.
		if (!sawFinalAnswer && message.content && contentCursor < message.content.length) {
			const remaining = message.content.slice(contentCursor);
			if (remaining.length > 0) {
				const last = res.at(-1);
				if (last?.type === "text") last.content += remaining;
				else res.push({ type: "text" as const, content: remaining });
			}
		} else if (!res.some((b) => b.type === "text") && message.content) {
			// Fallback: no text produced at all
			res.push({ type: "text" as const, content: message.content });
		}

		return expandArtifactBlocks(expandThinkBlocks(res));
	});

	// Coalesce consecutive process blocks (thinking + tools) into groups so they can
	// collapse into a single "Called N tools" / "Thought" summary. Text passes through.
	let renderUnits = $derived.by(() => {
		const units: RenderUnit[] = [];
		let current: ProcessBlock[] | null = null;
		const flush = () => {
			if (current && current.length) {
				const toolCount = current.filter((b) => b.type === "tool").length;
				units.push({ kind: "group", blocks: current, toolCount });
			}
			current = null;
		};
		for (const block of blocks) {
			if (block.type === "think" || block.type === "tool") {
				(current ??= []).push(block);
			} else if (block.type === "artifact") {
				flush();
				units.push({ kind: "artifact", op: block.op, opIndex: block.opIndex });
			} else if (block.type === "elicitation") {
				// Never folded into the collapsible summary: the user has to be able to act on it.
				flush();
				units.push({
					kind: "elicitation",
					request: block.request,
					expiresAt: block.expiresAt,
					resolved: block.resolved,
				});
			} else if (block.type === "codeExecution") {
				// Never folded into the collapsible summary: the run happens here.
				flush();
				units.push({
					kind: "codeExecution",
					request: block.request,
					resolved: block.resolved,
				});
			} else if (block.type === "plan") {
				// Never folded into the collapsible summary: the plan stays visible.
				flush();
				units.push({ kind: "plan", update: block.update });
			} else if (block.type === "memory") {
				// Never folded either: a write to something that outlives the
				// conversation must not end up behind a "3 steps" disclosure, or
				// the undo is only found by people who go looking for it.
				flush();
				units.push({ kind: "memory", update: block.update });
			} else if (block.type === "backgroundTask") {
				// Never folded either: a background child's status has to stay
				// readable after the turn ends — that is the whole point of
				// the marker.
				flush();
				units.push({ kind: "backgroundTask", update: block.update });
			} else if (block.type === "subagent") {
				// Never folded into the summary either: a subagent's status has
				// to stay readable after the turn ends — that is the whole point
				// of tracking it to a terminal state.
				flush();
				units.push({
					kind: "subagent",
					uuid: block.uuid,
					anchor: block.anchor,
					updates: block.updates,
				});
			} else {
				flush();
				units.push({ kind: "text", content: block.content });
			}
		}
		flush();
		return units;
	});

	/** Reasoning, a running tool and growing text animate; a finished tool, a
	 * settled question and a terminal subagent do not. A subagent still
	 * running — polled or merely unpaired — keeps the shimmer. */
	let trailingBlockShowsProgress = $derived.by(() => {
		const last = blocks.at(-1);
		if (!last) return false;
		if (last.type === "think") return !last.closed;
		if (last.type === "tool") {
			return !last.updates.some(
				(update) => isMessageToolResultUpdate(update) || isMessageToolErrorUpdate(update)
			);
		}
		if (last.type === "subagent") {
			return !last.anchor.subagent || last.anchor.subagent.status === "running";
		}
		if (last.type === "backgroundTask") {
			return last.update.state === "running";
		}
		if (last.type === "text") return last.content.trim().length > 0;
		return false;
	});

	// A streaming turn with process blocks renders them flat for its whole
	// duration — mid-turn narration between tool rounds must not regroup the
	// rows into the collapsed summary, or every new round visibly "re-expands"
	// them. The nested summary takes over only once the turn is over.
	let isProcessStreaming = $derived.by(() => {
		if (!isLast || !loading) return false;
		return blocks.some(
			(block) =>
				block.type === "think" ||
				block.type === "tool" ||
				block.type === "elicitation" ||
				block.type === "plan" ||
				block.type === "memory" ||
				block.type === "backgroundTask" ||
				block.type === "subagent"
		);
	});

	$effect(() => {
		if (isCopied) {
			setTimeout(() => {
				isCopied = false;
			}, 1000);
		}
	});

	// Tailwind's `prose` resets font-size to 1rem while the app shell uses
	// `text-smd` (0.94rem); re-applying it here keeps answer text — and every
	// em-scaled child (code, pre, lists, tables, KaTeX) — in line with the rest
	// of the UI. Single source for both the streaming and final render branches.
	const proseClasses =
		"prose max-w-none text-smd dark:prose-invert prose-headings:font-semibold prose-h1:text-lg prose-h2:text-base prose-h3:text-base prose-pre:bg-gray-800 prose-img:my-0 prose-img:cursor-pointer prose-img:rounded-lg dark:prose-pre:bg-gray-900";

	let editMode = $derived(editMsdgId === message.id);
	$effect(() => {
		if (editMode) {
			tick();
			if (editContentEl) {
				editContentEl.value = message.content;
				// preventScroll: a bare focus() makes the browser reveal-scroll
				// the chat container, which the scroll controller would have to
				// classify as user input (and could misread as a re-pin). The
				// textarea replaces the message the user just clicked, so it is
				// already in view.
				editContentEl?.focus({ preventScroll: true });
			}
		}
	});
</script>

{#if message.from === "assistant"}
	<div
		bind:offsetWidth={messageWidth}
		class="group relative -mb-4 flex w-fit max-w-full items-start justify-start gap-4 pb-4 leading-relaxed max-sm:mb-1 {message.routerMetadata &&
		messageInfoWidth >= messageWidth
			? 'mb-1'
			: ''}"
		data-message-id={message.id}
		data-message-role="assistant"
		role="presentation"
		onclick={() => (isTapped = !isTapped)}
		onkeydown={() => (isTapped = !isTapped)}
	>
		<MessageAvatar
			classNames="mt-5 h-4 w-auto flex-none select-none max-sm:hidden"
			animating={isLast && loading}
		/>
		<div
			class="relative flex min-w-[60px] flex-col gap-2 rounded-2xl border border-line bg-linear-to-br from-gray-50 px-5 py-3.5 wrap-break-word text-gray-600 dark:from-gray-800/80 dark:text-gray-300 prose-pre:my-2"
		>
			{#if message.files?.length}
				<div class="flex h-fit flex-wrap gap-x-5 gap-y-2">
					{#each message.files as file (file.value)}
						<UploadedFile {file} canClose={false} />
					{/each}
				</div>
			{/if}

			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<div bind:this={contentEl} oncopy={handleCopy} onclick={handleContentClick}>
				{#if isLast && loading && blocks.length === 0}
					<IconLoading classNames="loading inline ml-2 first:ml-0" />
				{/if}
				{#if isProcessStreaming}
					<!-- A streaming turn that used thinking / tools: every block renders flat
					     and inline until the turn ends, then the nested summary takes over. -->
					{#each blocks as block, blockIndex (block.type === "tool" ? `tool-${block.uuid}-${blockIndex}` : block.type === "plan" ? `plan-${block.update.version}` : block.type === "subagent" ? `subagent-${block.uuid}` : block.type === "backgroundTask" ? `background-${block.update.taskId}-${block.update.state}` : `block-${blockIndex}`)}
						{#if block.type === "text"}
							{#if block.content.trim().length > 0}
								<div class={proseClasses}>
									<MarkdownRenderer
										content={block.content}
										loading={isLast && loading}
										autorun={message.from === "assistant"}
									/>
								</div>
							{/if}
						{:else if block.type === "artifact"}
							<ArtifactCard op={block.op} messageId={message.id} opIndex={block.opIndex} />
						{:else if block.type === "elicitation"}
							<div data-exclude-from-copy>
								{#if block.request.toolApproval}
									<ToolApprovalCard
										conversationId={convId}
										request={block.request}
										expiresAt={block.expiresAt}
										resolved={block.resolved}
										onanswer={onanswerElicitation
											? (action, scope) => onanswerElicitation(block.request, action, scope)
											: undefined}
									/>
								{:else}
									<ElicitationForm
										conversationId={convId}
										request={block.request}
										expiresAt={block.expiresAt}
										resolved={block.resolved}
									/>
								{/if}
							</div>
						{:else if block.type === "codeExecution"}
							<div data-exclude-from-copy>
								<CodeExecutionCard
									conversationId={convId}
									request={block.request}
									resolved={block.resolved}
								/>
							</div>
						{:else if block.type === "plan"}
							<div data-exclude-from-copy>
								<PlanCard update={block.update} />
							</div>
						{:else if block.type === "memory"}
							<div data-exclude-from-copy>
								<MemoryCard update={block.update} />
							</div>
						{:else if block.type === "backgroundTask"}
							<div data-exclude-from-copy>
								<BackgroundTaskCard update={block.update} />
							</div>
						{:else if block.type === "subagent"}
							<div data-exclude-from-copy>
								{#if subagentCard}
									{@render subagentCard(block.anchor)}
								{:else}
									<!-- Defensive: a caller that claims subagents without
									     supplying their card falls back to the generic
									     row rather than losing the call. -->
									<ToolUpdate tool={block.updates} {loading} />
								{/if}
							</div>
						{:else}
							<div data-exclude-from-copy class="not-last:mb-1 has-[+.prose]:mb-2! [.prose+&]:mt-3">
								{#if block.type === "think"}
									<!-- Only the trailing block can still be streaming: an earlier
									     unclosed think is a stream artifact (e.g. a lost close marker)
									     and must not keep shimmering or re-expanding on every render. -->
									<OpenReasoningResults
										content={block.content}
										loading={isLast && loading && !block.closed && blockIndex === blocks.length - 1}
									/>
								{:else}
									<ToolUpdate tool={block.updates} {loading} />
								{/if}
							</div>
						{/if}
					{/each}
					{#if !trailingBlockShowsProgress}
						<IconLoading classNames="loading mt-1 inline first:ml-0" />
					{/if}
				{:else}
					<!-- Answer started or generation finished: nest the process blocks. -->
					{#each renderUnits as unit, unitIndex (unit.kind === "plan" ? `plan-${unit.update.version}` : unit.kind === "subagent" ? `subagent-${unit.uuid}` : unit.kind === "backgroundTask" ? `background-${unit.update.taskId}-${unit.update.state}` : `${unit.kind}-${unitIndex}`)}
						{#if unit.kind === "text"}
							{#if isLast && loading && unit.content.length === 0}
								<IconLoading classNames="loading inline ml-2 first:ml-0" />
							{:else if unit.content.trim().length > 0}
								<div class={proseClasses}>
									<MarkdownRenderer
										content={unit.content}
										loading={isLast && loading}
										autorun={message.from === "assistant"}
									/>
								</div>
							{/if}
						{:else if unit.kind === "artifact"}
							<ArtifactCard op={unit.op} messageId={message.id} opIndex={unit.opIndex} />
						{:else if unit.kind === "elicitation"}
							<div data-exclude-from-copy>
								{#if unit.request.toolApproval}
									<ToolApprovalCard
										conversationId={convId}
										request={unit.request}
										expiresAt={unit.expiresAt}
										resolved={unit.resolved}
										onanswer={onanswerElicitation
											? (action, scope) => onanswerElicitation(unit.request, action, scope)
											: undefined}
									/>
								{:else}
									<ElicitationForm
										conversationId={convId}
										request={unit.request}
										expiresAt={unit.expiresAt}
										resolved={unit.resolved}
									/>
								{/if}
							</div>
						{:else if unit.kind === "codeExecution"}
							<div data-exclude-from-copy>
								<CodeExecutionCard
									conversationId={convId}
									request={unit.request}
									resolved={unit.resolved}
								/>
							</div>
						{:else if unit.kind === "plan"}
							<div data-exclude-from-copy>
								<PlanCard update={unit.update} />
							</div>
						{:else if unit.kind === "memory"}
							<div data-exclude-from-copy>
								<MemoryCard update={unit.update} />
							</div>
						{:else if unit.kind === "backgroundTask"}
							<div data-exclude-from-copy>
								<BackgroundTaskCard update={unit.update} />
							</div>
						{:else if unit.kind === "subagent"}
							<div data-exclude-from-copy>
								{#if subagentCard}
									{@render subagentCard(unit.anchor)}
								{:else}
									<!-- Defensive fallback, same as the flat branch's. -->
									<ToolUpdate tool={unit.updates} loading={false} />
								{/if}
							</div>
						{:else if unit.kind === "group"}
							<div data-exclude-from-copy class="not-last:mb-1 has-[+.prose]:mb-2! [.prose+&]:mt-3">
								{#if unit.blocks.length > 1}
									<!-- Collapse the whole run into a single summary -->
									<ToolCallsSummary blocks={unit.blocks} toolCount={unit.toolCount} />
								{:else}
									<!-- A lone process block stays standalone -->
									{@const only = unit.blocks[0]}
									{#if only.type === "think"}
										<OpenReasoningResults content={only.content} loading={false} />
									{:else}
										<ToolUpdate tool={only.updates} loading={false} />
									{/if}
								{/if}
							</div>
						{/if}
					{/each}
				{/if}
			</div>

			{#if waitingState}
				<TurnWaitBanner
					until={waitingState.until ?? 0}
					reason={waitingState.reason}
					conversationId={convId}
					messageId={message.id}
					canWake={isAuthor && !readOnly}
				/>
			{/if}
		</div>

		{#if message.routerMetadata || (!loading && message.content)}
			<div
				class="absolute -bottom-3.5 {message.routerMetadata && messageInfoWidth > messageWidth
					? 'left-1 pl-1 @2xl:pl-7'
					: 'right-1'} flex max-w-[100cqw] items-center gap-0.5"
				bind:offsetWidth={messageInfoWidth}
			>
				{#if message.routerMetadata && (message.routerMetadata.route || message.routerMetadata.model || message.routerMetadata.provider) && (!isLast || !loading)}
					<div
						class="mr-2 flex items-center gap-1.5 truncate text-[.65rem] whitespace-nowrap text-gray-400 @xl:text-xs dark:text-gray-400 dark:opacity-50"
					>
						{#if message.routerMetadata.route && message.routerMetadata.model}
							<span
								class="truncate rounded-sm bg-gray-100 px-1 font-mono @xl:py-px dark:bg-gray-800"
							>
								{message.routerMetadata.route}
							</span>
							<span class="text-gray-500">with</span>
							{#if publicConfig.isHuggingChat}
								<!-- A button that navigates rather than a link: it sits
								     inside the message's footer where a nested anchor
								     would be invalid, and the workspace address is
								     where a model's settings live now. -->
								<button
									type="button"
									onclick={() => {
										const model = message.routerMetadata?.model;
										if (model)
											void goto(
												`${base}/workspace?${new URLSearchParams({ tab: "models", id: model })}`
											);
									}}
									class="flex items-center gap-1 truncate rounded-sm bg-gray-100 px-1 font-mono hover:text-gray-500 @xl:py-px dark:bg-gray-800 dark:hover:text-gray-300"
								>
									{message.routerMetadata.model.split("/").pop()}
								</button>
							{:else}
								<span
									class="truncate rounded-sm bg-gray-100 px-1.5 font-mono @xl:py-px dark:bg-gray-800"
								>
									{message.routerMetadata.model.split("/").pop()}
								</span>
							{/if}
						{/if}
						{#if message.routerMetadata.provider}
							{@const hubOrg = PROVIDERS_HUB_ORGS[message.routerMetadata.provider]}
							<span class="text-gray-500 @max-xl:hidden">via</span>
							<a
								target="_blank"
								href="https://huggingface.co/{hubOrg}"
								class="flex items-center gap-1 truncate rounded-sm bg-gray-100 px-1 font-mono hover:text-gray-500 @max-xl:hidden @xl:py-px dark:bg-gray-800 dark:hover:text-gray-300"
							>
								<img
									src="https://huggingface.co/api/avatars/{hubOrg}"
									alt="{message.routerMetadata.provider} logo"
									class="size-2.5 flex-none rounded-xs"
									onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
								/>
								{message.routerMetadata.provider}
							</a>
						{/if}
					</div>
				{/if}
				{#if !isLast || !loading}
					<CopyToClipBoardBtn
						onClick={() => {
							isCopied = true;
						}}
						classNames="btn rounded-xs p-1 text-sm text-gray-400 hover:text-gray-500 focus:ring-0 dark:text-gray-400 dark:hover:text-gray-300"
						value={contentWithoutThink}
						iconClassNames="text-xs"
					/>
					{#if onretry}
						<button
							class="btn rounded-xs p-1 text-xs text-gray-400 hover:text-gray-500 focus:ring-0 dark:text-gray-400 dark:hover:text-gray-300"
							title="Retry"
							type="button"
							onclick={() => {
								onretry?.({ id: message.id });
							}}
						>
							<CarbonRotate360 />
						</button>
					{/if}
					{#if messageActions && turnStateOf(message)?.state === "done"}
						{@render messageActions(message)}
					{/if}
					{#if alternatives.length > 1 && editMsdgId === null}
						<Alternatives
							{message}
							{alternatives}
							{loading}
							onshowAlternateMsg={(payload) => onshowAlternateMsg?.(payload)}
						/>
					{/if}
				{/if}
			</div>
		{/if}
	</div>
	{#if lightboxSrc}
		<ImageLightbox src={lightboxSrc} onclose={() => (lightboxSrc = null)} />
	{/if}
{/if}
{#if message.from === "user"}
	<div
		class="group relative {alternatives.length > 1 && editMsdgId === null
			? 'mb-7'
			: ''} w-full items-start justify-start gap-4"
		data-message-id={message.id}
		data-message-type="user"
		role="presentation"
		onclick={() => (isTapped = !isTapped)}
		onkeydown={() => (isTapped = !isTapped)}
	>
		<div class="flex w-full flex-col gap-2">
			{#if message.files?.length}
				<div class="flex w-fit gap-4 px-5">
					{#each message.files as file}
						<UploadedFile {file} canClose={false} {fileBaseUrl} />
					{/each}
				</div>
			{/if}

			<div class="flex w-full flex-row flex-nowrap">
				{#if !editMode}
					{#if message.sentBy}
						<!-- Another session wrote this with `session_send`: not the
						     person's words, so it is drawn as a different voice — a
						     tinted card, headed by who it is from and a link to them. -->
						<div class="w-full px-5 py-3.5" data-testid="sent-by-agent">
							<div
								class="w-fit max-w-full rounded-xl border border-violet-200 bg-violet-50/70 px-3 py-2 dark:border-violet-800/50 dark:bg-violet-900/15"
							>
								<p
									class="mb-1 flex min-w-0 items-center gap-1 text-xs font-medium text-violet-700 dark:text-violet-300"
								>
									<LucideBot class="size-3.5 shrink-0" />
									<span class="shrink-0">From agent</span>
									{#if sessionLinks}
										<a
											href={sessionLinks.href(message.sentBy.sessionId)}
											class="min-w-0 truncate underline-offset-2 hover:underline"
											data-testid="sent-by-link">{message.sentBy.title}</a
										>
									{:else}
										<span class="min-w-0 truncate">{message.sentBy.title}</span>
									{/if}
								</p>
								<p
									class="text-wrap wrap-break-word whitespace-break-spaces text-gray-600 dark:text-gray-300"
								>
									{message.content.trim()}
								</p>
							</div>
						</div>
					{:else if message.command}
						<!-- A slash command run (PROTOCOL.md §7): the bubble is the
						     invocation; the expanded template — which opencode ran
						     on this machine as the prompt — folds into a collapsed
						     disclosure beneath it, so the transcript reads the
						     command while keeping every word it produced. -->
						<div class="w-full px-5 py-3.5">
							<p
								class="w-fit rounded-lg bg-gray-100 px-2 py-1 font-mono text-sm wrap-break-word text-gray-600 dark:bg-gray-800 dark:text-gray-300"
							>
								/{message.command.name}{message.command.arguments
									? ` ${message.command.arguments}`
									: ""}
							</p>
							<details class="mt-1">
								<summary
									class="cursor-pointer text-xs text-gray-400 select-none dark:text-gray-500"
								>
									Expanded command
								</summary>
								<p
									class="mt-1 text-sm text-wrap wrap-break-word whitespace-break-spaces text-gray-500 dark:text-gray-400"
								>
									{message.content.trim()}
								</p>
							</details>
						</div>
					{:else}
						<CollapsibleUserText
							text={message.content.trim()}
							class="disabled w-full appearance-none bg-inherit px-5 py-3.5 text-wrap wrap-break-word whitespace-break-spaces text-gray-600 dark:text-gray-300"
						/>
					{/if}
				{:else}
					<form
						class="mt-3 flex w-full flex-col"
						bind:this={editFormEl}
						onsubmit={(e) => {
							e.preventDefault();
							onretry?.({ content: editContentEl?.value, id: message.id });
							editMsdgId = null;
						}}
					>
						<textarea
							class="w-full rounded-xl bg-gray-100 px-5 py-3.5 wrap-break-word whitespace-break-spaces text-gray-700 *:h-max focus:outline-hidden dark:bg-gray-800 dark:text-gray-200"
							rows="5"
							bind:this={editContentEl}
							value={message.content.trim()}
							onkeydown={handleKeyDown}
							required
						></textarea>
						<div class="flex w-full flex-row flex-nowrap items-center justify-center gap-2 pt-2">
							<button
								type="submit"
								class="btn rounded-lg px-3 py-1.5 text-sm
                                {loading
									? 'bg-gray-200 text-gray-400 dark:bg-gray-800 dark:text-gray-600'
									: 'bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-800 focus:ring-0 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-gray-200'}
								"
								disabled={loading}
							>
								Send
							</button>
							<button
								type="button"
								class="btn rounded-xs p-2 text-sm text-gray-400 hover:text-gray-500 focus:ring-0 dark:text-gray-400 dark:hover:text-gray-300"
								onclick={() => {
									editMsdgId = null;
								}}
							>
								Cancel
							</button>
						</div>
					</form>
				{/if}
			</div>
			<div class="absolute -bottom-4 ml-3.5 flex w-full items-center gap-1.5">
				{#if alternatives.length > 1 && editMsdgId === null}
					<Alternatives
						{message}
						{alternatives}
						{loading}
						onshowAlternateMsg={(payload) => onshowAlternateMsg?.(payload)}
					/>
				{/if}
				{#if (alternatives.length > 1 && editMsdgId === null) || (!loading && !editMode)}
					{#if onretry}
						<button
							class="hidden h-5 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-gray-400 group-hover:flex hover:flex hover:bg-gray-100 hover:text-gray-500 lg:-right-2 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-300 {isTapped
								? '[@media(hover:none)]:flex'
								: ''}"
							title="Edit"
							type="button"
							onclick={() => {
								if (requireAuthUser()) return;
								editMsdgId = message.id;
							}}
						>
							<CarbonPen />
							Edit
						</button>
					{/if}
					<button
						class="hidden h-5 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs group-hover:flex hover:flex hover:bg-gray-100 lg:-right-2 dark:hover:bg-gray-800 {isTapped
							? '[@media(hover:none)]:flex'
							: ''} {isUserMsgCopied
							? 'text-green-500 dark:text-green-400'
							: 'text-gray-400 hover:text-gray-500 dark:text-gray-400 dark:hover:text-gray-300'}"
						title="Copy to clipboard"
						type="button"
						onclick={async () => {
							try {
								if (window.isSecureContext && navigator.clipboard) {
									await navigator.clipboard.writeText(message.content);
								} else {
									const textArea = document.createElement("textarea");
									textArea.value = message.content;
									// Off-screen + preventScroll so the legacy copy path
									// (insecure contexts) can't scroll-jump or shift layout.
									textArea.style.cssText = "position: fixed; opacity: 0;";
									document.body.appendChild(textArea);
									textArea.focus({ preventScroll: true });
									textArea.select();
									document.execCommand("copy");
									document.body.removeChild(textArea);
								}
								isUserMsgCopied = true;
								clearTimeout(userCopyTimeout);
								userCopyTimeout = setTimeout(() => {
									isUserMsgCopied = false;
								}, 1000);
							} catch (err) {
								console.error("Failed to copy:", err);
							}
						}}
					>
						{#if isUserMsgCopied}
							<CarbonCheckmark class="scale-[0.85]" />
							Copied
						{:else}
							<CarbonCopy class="scale-[0.85]" />
							Copy
						{/if}
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	@keyframes loading {
		to {
			stroke-dashoffset: 122.9;
		}
	}
</style>
