<!--
	Skills, as a workspace tab: the person's own SKILL.md documents plus the
	read-only admin seeds.

	Four views in one screen rather than four pages — list, create, edit and
	one skill's body — mirroring KnowledgeManager's `view` switching for the
	same reason: somebody managing skills is doing one task and should not
	lose their place at each step. The dialog language is the MCP one
	(`overlay/styles.ts`); the shape is sparse on purpose, plumbing with a
	face rather than a showcase.
-->
<script lang="ts">
	import { onMount, untrack } from "svelte";
	import { base } from "$app/paths";
	import IconAddLarge from "~icons/carbon/add-large";
	import IconTrash from "~icons/carbon/trash-can";
	import IconView from "~icons/carbon/view";
	import IconArrowLeft from "~icons/carbon/arrow-left";
	import IconDocument from "~icons/carbon/document";
	import * as s from "$lib/components/overlay/styles";

	interface UserSkill {
		id: string;
		name: string;
		description: string;
		enabled: boolean;
		updatedAt: string;
	}

	interface AdminSkill {
		name: string;
		description: string;
		readOnly: true;
	}

	interface Props {
		/** Open straight onto one user skill, for `/workspace?tab=skills&id=…`. */
		initialId?: string;
	}

	let { initialId }: Props = $props();

	type View = "list" | "create" | "edit" | "detail" | "admin";
	// Read once: `initialId` is the address somebody arrived on. A `$derived`
	// here would drag them back to the detail view every time they navigated
	// to the list inside the manager.
	let view = $state<View>(untrack(() => (initialId ? "detail" : "list")));

	let userSkills = $state<UserSkill[]>([]);
	let adminSkills = $state<AdminSkill[]>([]);
	let loading = $state(true);
	let failure = $state<string | null>(null);

	// The create/edit form holds raw SKILL.md text: what is stored is what
	// was typed, frontmatter included, so a skill ports out unchanged.
	let formContent = $state("");
	let formError = $state<string | null>(null);
	let formBusy = $state(false);
	let editing = $state<UserSkill | null>(null);

	// One skill's body, fetched on demand — the list carries frontmatter only.
	let detailName = $state("");
	let detailDescription = $state("");
	let detailContent = $state("");
	let detailLoading = $state(false);
	let detailReadOnly = $state(false);

	// Two-step delete: the first click arms, the second confirms.
	let deleteArmed = $state<string | null>(null);

	const enabledCount = $derived(userSkills.filter((skill) => skill.enabled).length);

	const PLACEHOLDER = `---\nname: my-skill\ndescription: What this skill does, in one line the model matches against.\n---\n\n# My skill\n\nWhen to use it, then the procedure as numbered steps.\n`;

	async function api<T>(
		path: string,
		init?: { method?: string; headers?: Record<string, string>; body?: string }
	): Promise<T> {
		const response = await fetch(`${base}/api/v2/skills${path}`, init);
		if (!response.ok) {
			const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
			throw new Error(parsed?.message ?? `The request failed (${response.status}).`);
		}
		return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
	}

	function json(body: unknown, method = "POST") {
		return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
	}

	async function load() {
		failure = null;
		try {
			const listed = await api<{ data: { user: UserSkill[]; admin: AdminSkill[] } }>("");
			userSkills = listed.data.user;
			adminSkills = listed.data.admin;
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not load skills.";
		} finally {
			loading = false;
		}
	}

	// `onMount`, not the component body: this manager also renders as a page
	// body, which runs on the server, where a relative fetch has no origin
	// to resolve against.
	onMount(() =>
		load().then(() => {
			if (initialId) void openDetail(initialId);
		})
	);

	function openCreate() {
		editing = null;
		formContent = "";
		formError = null;
		view = "create";
	}

	async function create() {
		if (!formContent.trim() || formBusy) return;
		formBusy = true;
		formError = null;
		try {
			const created = await api<{ data: UserSkill }>("", json({ content: formContent }));
			userSkills = [...userSkills, created.data].sort((a, b) => a.name.localeCompare(b.name));
			view = "list";
		} catch (err) {
			formError = err instanceof Error ? err.message : "Could not create the skill.";
		} finally {
			formBusy = false;
		}
	}

	async function openEdit(skill: UserSkill) {
		editing = skill;
		formError = null;
		formBusy = false;
		try {
			const loaded = await api<{ data: UserSkill & { content: string } }>(`/${skill.id}`);
			formContent = loaded.data.content;
			view = "edit";
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not load the skill.";
		}
	}

	async function saveEdit() {
		if (!editing || !formContent.trim() || formBusy) return;
		formBusy = true;
		formError = null;
		try {
			const updated = await api<{ data: UserSkill }>(
				`/${editing.id}`,
				json({ content: formContent }, "PATCH")
			);
			userSkills = userSkills.map((skill) => (skill.id === editing?.id ? updated.data : skill));
			editing = null;
			view = "list";
		} catch (err) {
			formError = err instanceof Error ? err.message : "Could not save the skill.";
		} finally {
			formBusy = false;
		}
	}

	async function toggle(skill: UserSkill) {
		try {
			const updated = await api<{ data: UserSkill }>(
				`/${skill.id}`,
				json({ enabled: !skill.enabled }, "PATCH")
			);
			userSkills = userSkills.map((entry) => (entry.id === skill.id ? updated.data : entry));
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not change the skill.";
		}
	}

	async function confirmDelete(skill: UserSkill) {
		if (deleteArmed !== skill.id) {
			deleteArmed = skill.id;
			return;
		}
		deleteArmed = null;
		try {
			await api<void>(`/${skill.id}`, { method: "DELETE" });
			userSkills = userSkills.filter((entry) => entry.id !== skill.id);
			if (editing?.id === skill.id) {
				editing = null;
				view = "list";
			}
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not delete the skill.";
		}
	}

	async function openDetail(id: string) {
		detailLoading = true;
		detailReadOnly = false;
		try {
			const loaded = await api<{ data: UserSkill & { content: string } }>(`/${id}`);
			detailName = loaded.data.name;
			detailDescription = loaded.data.description;
			detailContent = loaded.data.content;
			view = "detail";
		} catch {
			view = "list";
		} finally {
			detailLoading = false;
		}
	}

	async function openAdmin(name: string) {
		detailLoading = true;
		detailReadOnly = true;
		try {
			const loaded = await api<{
				data: { name: string; description: string; content: string };
			}>(`/admin/${encodeURIComponent(name)}`);
			detailName = loaded.data.name;
			detailDescription = loaded.data.description;
			detailContent = loaded.data.content;
			view = "admin";
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not load the skill.";
		} finally {
			detailLoading = false;
		}
	}

	function back() {
		editing = null;
		deleteArmed = null;
		view = "list";
	}
</script>

<div class={s.EMBEDDED}>
	<div class="p-6">
		<div class="mb-6">
			<h2 class="mb-1 text-xl font-semibold text-gray-900 dark:text-gray-200">Skills</h2>
			<p class="text-sm text-gray-600 dark:text-gray-400">
				Reusable procedures the model follows — your own SKILL.md documents, plus the deployment's
				read-only seeds.
			</p>
		</div>

		{#if failure}
			<div class="{s.ERROR} mb-4" role="alert">{failure}</div>
		{/if}

		{#if view === "list"}
			<div
				class="mb-6 flex justify-between rounded-lg p-4 max-sm:flex-col max-sm:gap-4 sm:items-center {enabledCount ||
				adminSkills.length
					? 'bg-blue-50 dark:bg-blue-900/10'
					: 'bg-gray-100 dark:bg-white/5'}"
			>
				<div class="flex items-center gap-3">
					<div
						class="flex size-10 items-center justify-center rounded-xl bg-blue-500/10"
						class:grayscale={!enabledCount && !adminSkills.length}
					>
						<IconDocument class="size-8 text-blue-600 dark:text-blue-500" />
					</div>
					<div>
						<p class="text-sm font-semibold text-gray-900 dark:text-gray-100">
							{userSkills.length}
							{userSkills.length === 1 ? "skill" : "skills"} of yours
						</p>
						<p class="text-xs text-gray-600 dark:text-gray-400">
							{enabledCount} enabled · {adminSkills.length} deployment seeds
						</p>
					</div>
				</div>
				<div class="flex gap-2">
					<button onclick={openCreate} class={s.PRIMARY}>
						<IconAddLarge class="size-4" /> New skill
					</button>
				</div>
			</div>

			<div class="space-y-5">
				{#if loading}
					<p class="text-sm text-gray-500 dark:text-gray-400">Loading skills…</p>
				{:else}
					{#if userSkills.length === 0}
						<div class={s.EMPTY}>
							<IconDocument class={s.EMPTY_ICON} />
							<p class={s.EMPTY_TITLE}>No skills yet</p>
							<p class={s.EMPTY_DETAIL}>Write one as SKILL.md — frontmatter plus procedure.</p>
							<button onclick={openCreate} class={s.PRIMARY}>
								<IconAddLarge class="size-4" /> New skill
							</button>
						</div>
					{:else}
						<div>
							<h3 class={s.SECTION_TITLE}>Your skills ({userSkills.length})</h3>
							<div class={s.GRID}>
								{#each userSkills as skill (skill.id)}
									<div class={s.card(skill.enabled)}>
										<div class={s.CARD_BODY}>
											<div class="flex items-start justify-between gap-2">
												<div class="min-w-0">
													<p class={s.CARD_TITLE}>{skill.name}</p>
													<p class={s.CARD_SUBTITLE}>{skill.description}</p>
												</div>
												<span class="{s.PILL} {s.PILL_TONES[skill.enabled ? 'good' : 'neutral']}">
													{skill.enabled ? "On" : "Off"}
												</span>
											</div>
											<div class="mt-3 flex flex-wrap gap-1.5">
												<button onclick={() => void openDetail(skill.id)} class={s.CARD_ACTION}>
													<IconView class="size-3.5" /> View
												</button>
												<button onclick={() => void toggle(skill)} class={s.CARD_ACTION}>
													{skill.enabled ? "Disable" : "Enable"}
												</button>
												<button onclick={() => void openEdit(skill)} class={s.CARD_ACTION}>
													Edit
												</button>
												<button
													onclick={() => void confirmDelete(skill)}
													class={s.CARD_DESTRUCTIVE}
												>
													<IconTrash class="size-3.5" />
													{deleteArmed === skill.id ? "Confirm delete" : "Delete"}
												</button>
											</div>
										</div>
									</div>
								{/each}
							</div>
						</div>
					{/if}

					{#if adminSkills.length > 0}
						<div>
							<h3 class={s.SECTION_TITLE}>
								Deployment seeds ({adminSkills.length}) — read-only
							</h3>
							<div class={s.GRID}>
								{#each adminSkills as skill (skill.name)}
									<div class={s.card(false)}>
										<div class={s.CARD_BODY}>
											<div class="flex items-start justify-between gap-2">
												<div class="min-w-0">
													<p class={s.CARD_TITLE}>{skill.name}</p>
													<p class={s.CARD_SUBTITLE}>{skill.description}</p>
												</div>
												<span class="{s.PILL} {s.PILL_TONES.neutral}">Seed</span>
											</div>
											<div class="mt-3 flex flex-wrap gap-1.5">
												<button onclick={() => void openAdmin(skill.name)} class={s.CARD_ACTION}>
													<IconView class="size-3.5" /> View
												</button>
											</div>
										</div>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				{/if}

				<div class={s.TIPS}>
					<h4 class={s.TIPS_TITLE}>💡 Quick Tips</h4>
					<ul class={s.TIPS_LIST}>
						<li>• Name a skill with @name in chat to load its full instructions that turn</li>
						<li>• Otherwise the model loads a skill itself when its description matches</li>
						<li>• Skills run standard-library Python in your browser — never shell or packages</li>
						<li>• Skills are yours alone: no sharing in this version</li>
					</ul>
				</div>
			</div>
		{:else if view === "create" || view === "edit"}
			<div class="mb-4">
				<button onclick={back} class={s.CARD_ACTION}>
					<IconArrowLeft class="size-3.5" /> Back to skills
				</button>
			</div>
			<h3 class="mb-1 text-base font-semibold text-gray-900 dark:text-gray-100">
				{view === "create" ? "New skill" : `Edit ${editing?.name ?? "skill"}`}
			</h3>
			<p class="mb-4 text-sm text-gray-600 dark:text-gray-400">
				Valid SKILL.md: YAML frontmatter with <code>name</code> and
				<code>description</code>, then the procedure as markdown.
			</p>
			{#if formError}
				<div class="{s.ERROR} mb-4" role="alert">{formError}</div>
			{/if}
			<label class={s.LABEL} for="skill-content">SKILL.md</label>
			<textarea
				id="skill-content"
				bind:value={formContent}
				rows={18}
				spellcheck={false}
				placeholder={PLACEHOLDER}
				class="{s.INPUT} font-mono text-xs"
			></textarea>
			<div class="mt-4 flex gap-2">
				{#if view === "create"}
					<button
						onclick={() => void create()}
						disabled={formBusy || !formContent.trim()}
						class={s.PRIMARY}
					>
						<IconAddLarge class="size-4" />
						{formBusy ? "Creating…" : "Create skill"}
					</button>
				{:else}
					<button
						onclick={() => void saveEdit()}
						disabled={formBusy || !formContent.trim()}
						class={s.PRIMARY}
					>
						{formBusy ? "Saving…" : "Save changes"}
					</button>
				{/if}
				<button onclick={back} class={s.SECONDARY}>Cancel</button>
			</div>
		{:else}
			<div class="mb-4">
				<button onclick={back} class={s.CARD_ACTION}>
					<IconArrowLeft class="size-3.5" /> Back to skills
				</button>
			</div>
			{#if detailLoading}
				<p class="text-sm text-gray-500 dark:text-gray-400">Loading skill…</p>
			{:else}
				<div class="mb-2 flex items-center gap-2">
					<h3 class="text-base font-semibold text-gray-900 dark:text-gray-100">{detailName}</h3>
					{#if detailReadOnly}
						<span class="{s.PILL} {s.PILL_TONES.neutral}">Read-only seed</span>
					{/if}
				</div>
				<p class="mb-4 text-sm text-gray-600 dark:text-gray-400">{detailDescription}</p>
				<pre
					class="scrollbar-custom max-h-[32rem] overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-4 font-mono text-xs whitespace-pre-wrap text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">{detailContent}</pre>
			{/if}
		{/if}
	</div>
</div>
