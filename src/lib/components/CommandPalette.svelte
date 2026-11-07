<!--
	The ⌘K / Ctrl-K palette: type part of a name and jump to a chat, a project, an
	agent session, a schedule, or a settings or workspace page.

	It reads what the sidebar already holds (the chat list, the projects and
	agent trees' caches) and asks the server only for what the sidebar may not
	have loaded when it opens: the projects, and the schedules. Nothing is
	fetched while it is closed. Ranking is `utils/commandPalette.ts`.

	The key is handled on the window, so it works from anywhere, including the
	composer. It is ignored while another dialog is open (the app is inert then)
	except to close this one, which is the Modal's own Escape.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import { goto } from "$app/navigation";
	import { onMount, tick } from "svelte";
	import Modal from "$lib/components/Modal.svelte";
	import { listSchedules } from "$lib/codeApi";
	import { codeTreeCache } from "$lib/stores/codeTreeCache.svelte";
	import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
	import { projectsTreeCache } from "$lib/stores/projectsTreeCache.svelte";
	import { filterPalette, type PaletteItem, type PaletteKind } from "$lib/utils/commandPalette";
	import type { ConvSidebar } from "$lib/types/ConvSidebar";
	import CarbonSearch from "~icons/carbon/search";
	import CarbonChat from "~icons/carbon/chat";
	import CarbonFolder from "~icons/carbon/folder";
	import CarbonCode from "~icons/carbon/code";
	import CarbonTime from "~icons/carbon/time";
	import CarbonDocument from "~icons/carbon/document";

	interface Props {
		conversations: ConvSidebar[];
		gatewayIsAdmin?: boolean | null;
	}
	let { conversations, gatewayIsAdmin = false }: Props = $props();

	let open = $state(false);
	let query = $state("");
	let active = $state(0);
	let input: HTMLInputElement | undefined = $state();

	let fetchedProjects = $state<{ id: string; name: string }[]>([]);
	let schedules = $state<{ id: string; name: string; kind: "chat" | "agent" }[]>([]);

	const data = $derived(
		page.data as {
			user?: unknown;
			chatSchedulesEnabled?: boolean;
			codeSchedulesEnabled?: boolean;
			codeAgentsEnabled?: boolean;
			usageEnabled?: boolean;
			knowledgeEnabled?: boolean;
			memoryEnabled?: boolean;
		}
	);
	const signedIn = $derived(Boolean(data.user));
	const schedulesOn = $derived(
		signedIn && (data.chatSchedulesEnabled === true || data.codeSchedulesEnabled === true)
	);

	function pages(): PaletteItem[] {
		const settings = m["app.nav.settings"]();
		const workspace = m["app.nav.workspace"]();
		const page = (key: string, label: string, href: string, detail?: string): PaletteItem => ({
			key: `page:${key}`,
			kind: "page",
			label,
			detail,
			href,
		});
		return [
			page("chats", m["app.nav.chats"](), "/chats"),
			page("projects", m["nav.projects.title"](), "/projects"),
			...(schedulesOn ? [page("schedules", m["app.nav.schedules"](), "/schedules")] : []),
			page("workspace", workspace, "/workspace"),
			page("w-models", m["workspace.tab.models"](), "/workspace?tab=models", workspace),
			...(data.memoryEnabled !== false
				? [page("w-memory", m["workspace.tab.memory"](), "/workspace?tab=memory", workspace)]
				: []),
			...(data.knowledgeEnabled !== false
				? [page("w-kb", m["workspace.tab.kb"](), "/workspace?tab=kb", workspace)]
				: []),
			page("w-skills", m["workspace.tab.skills"](), "/workspace?tab=skills", workspace),
			page("w-mcp", m["workspace.tab.mcp"](), "/workspace?tab=mcp", workspace),
			...(signedIn && data.codeAgentsEnabled === true
				? [page("w-agents", m["workspace.tab.agents"](), "/workspace?tab=agents", workspace)]
				: []),
			page("s-app", m["settings.tabs.application"](), "/settings/application", settings),
			...(signedIn
				? [
						page(
							"s-notifications",
							m["settings.tabs.notifications"](),
							"/settings/notifications",
							settings
						),
					]
				: []),
			...(signedIn && data.codeAgentsEnabled === true
				? [page("s-review", m["settings.tabs.review_log"](), "/settings/review-log", settings)]
				: []),
			...(data.usageEnabled
				? [page("s-usage", m["settings.tabs.usage"](), "/settings/usage", settings)]
				: []),
			...(gatewayIsAdmin ? [page("admin", m["app.nav.admin"](), "/admin")] : []),
		];
	}

	const items = $derived.by<PaletteItem[]>(() => {
		if (!open) return [];
		const projects = projectsTreeCache.loaded ? projectsTreeCache.projects : fetchedProjects;
		const projectName = (id?: string) => projects.find((p) => p.id === id)?.name;
		const chats: PaletteItem[] = conversations.map((conv) => ({
			key: `chat:${conv.id}`,
			kind: "chat",
			label: conv.title,
			detail: projectName(conv.projectId),
			href: `/conversation/${conv.id}`,
		}));
		const seen = new Set(chats.map((c) => c.key));
		// A project's chats live under it in the sidebar, not in the list above.
		for (const [projectId, list] of Object.entries(projectsTreeCache.chats)) {
			for (const chat of list) {
				const key = `chat:${chat.id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				chats.push({
					key,
					kind: "chat",
					label: chat.title,
					detail: projectName(projectId),
					href: `/conversation/${chat.id}`,
				});
			}
		}
		const agents: PaletteItem[] = [];
		if (data.codeAgentsEnabled === true) {
			for (const [deviceId, tree] of Object.entries(codeTreeCache.trees)) {
				const device = codeDeviceList.devices.find((d) => d.id === deviceId)?.name ?? "";
				for (const agent of tree.agents) {
					const workspace = tree.workspaces.find((w) => w.id === agent.workspaceId);
					agents.push({
						key: `agent:${deviceId}:${agent.id}`,
						kind: "agent",
						label: agent.title,
						detail: [device, workspace?.name].filter(Boolean).join(" › "),
						href: `/code?device=${deviceId}&ws=${agent.workspaceId}&agent=${agent.id}`,
					});
				}
			}
		}
		return [
			...pages(),
			...chats,
			...projects.map((p) => ({
				key: `project:${p.id}`,
				kind: "project" as const,
				label: p.name,
				href: `/projects/${p.id}`,
			})),
			...agents,
			...schedules.map((s) => ({
				key: `schedule:${s.id}`,
				kind: "schedule" as const,
				label: s.name,
				detail:
					s.kind === "chat" ? m["code.schedules.kind_chat"]() : m["code.schedules.kind_agent"](),
				href: `/schedules?schedule=${s.id}`,
			})),
		];
	});

	const results = $derived(filterPalette(items, query));
	$effect(() => {
		// A new query starts at the best match.
		void query;
		active = 0;
	});

	const KIND_LABEL: Record<PaletteKind, () => string> = {
		page: () => m["palette.group.pages"](),
		chat: () => m["palette.group.chats"](),
		project: () => m["palette.group.projects"](),
		agent: () => m["palette.group.agents"](),
		schedule: () => m["palette.group.schedules"](),
	};

	async function show() {
		query = "";
		active = 0;
		open = true;
		void load();
		await tick();
		input?.focus();
	}

	async function load() {
		if (signedIn && !projectsTreeCache.loaded) {
			try {
				const res = await fetch(`${base}/api/v2/projects`);
				if (res.ok) {
					const body = (await res.json()) as { data?: { id: string; name: string }[] };
					fetchedProjects = body.data ?? [];
				}
			} catch {
				// No projects in the list; everything else still works.
			}
		}
		if (schedulesOn) {
			try {
				schedules = (await listSchedules()).schedules.map((s) => ({
					id: s.id,
					name: s.name,
					kind: s.kind,
				}));
			} catch {
				schedules = [];
			}
		}
	}

	function choose(item: PaletteItem | undefined) {
		if (!item) return;
		open = false;
		void goto(`${base}${item.href}`);
	}

	function onInputKeydown(event: KeyboardEvent) {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			active = Math.min(results.length - 1, active + 1);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			active = Math.max(0, active - 1);
		} else if (event.key === "Enter") {
			event.preventDefault();
			choose(results[active]);
		}
		void tick().then(() =>
			document.getElementById(`palette-opt-${active}`)?.scrollIntoView({ block: "nearest" })
		);
	}

	onMount(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key?.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
			if (event.shiftKey || event.altKey) return;
			// Another dialog is open (the app is inert): leave its keys alone.
			if (!open && document.getElementById("app")?.hasAttribute("inert")) return;
			event.preventDefault();
			if (open) open = false;
			else void show();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	const ICONS = {
		page: CarbonDocument,
		chat: CarbonChat,
		project: CarbonFolder,
		agent: CarbonCode,
		schedule: CarbonTime,
	} as const;
</script>

{#if open}
	<Modal width="max-w-xl" labelledBy="palette-title" onclose={() => (open = false)} disableFly>
		<div class="flex flex-col" data-testid="command-palette">
			<h2 id="palette-title" class="sr-only">{m["palette.title"]()}</h2>
			<div class="flex items-center gap-2 border-b border-gray-200 px-3 dark:border-gray-700">
				<CarbonSearch class="size-4 shrink-0 text-gray-400" />
				<input
					bind:this={input}
					bind:value={query}
					onkeydown={onInputKeydown}
					type="text"
					role="combobox"
					aria-expanded="true"
					aria-controls="palette-list"
					aria-activedescendant={results.length ? `palette-opt-${active}` : undefined}
					autocomplete="off"
					spellcheck="false"
					placeholder={m["palette.placeholder"]()}
					class="h-12 w-full bg-transparent text-base outline-hidden placeholder:text-gray-400"
					style="font-size: 16px"
					data-testid="palette-input"
				/>
			</div>
			<div
				id="palette-list"
				role="listbox"
				aria-label={m["palette.title"]()}
				class="scrollbar-custom max-h-[50vh] overflow-y-auto p-1.5"
			>
				{#each results as item, index (item.key)}
					{@const Icon = ICONS[item.kind]}
					{#if index === 0 || results[index - 1].kind !== item.kind}
						<p
							class="px-2 pt-2 pb-1 text-xs font-semibold text-gray-400 first:pt-0.5 dark:text-gray-500"
						>
							{KIND_LABEL[item.kind]()}
						</p>
					{/if}
					<button
						type="button"
						id="palette-opt-{index}"
						role="option"
						aria-selected={index === active}
						data-testid="palette-option"
						data-kind={item.kind}
						class="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm {index ===
						active
							? 'bg-gray-100 dark:bg-gray-700'
							: ''}"
						onmousemove={() => (active = index)}
						onclick={() => choose(item)}
					>
						<Icon class="size-4 shrink-0 text-gray-400" />
						<span class="min-w-0 flex-1 truncate">{item.label}</span>
						{#if item.detail}
							<span class="max-w-[40%] shrink-0 truncate text-xs text-gray-400 dark:text-gray-500"
								>{item.detail}</span
							>
						{/if}
					</button>
				{:else}
					<p class="px-2 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
						{m["palette.empty"]()}
					</p>
				{/each}
			</div>
		</div>
	</Modal>
{/if}
