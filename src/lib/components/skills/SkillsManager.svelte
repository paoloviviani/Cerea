<!--
	Skills, as a workspace tab — and, with `admin`, as the admin panel's
	Skills section.

	Four views in one screen rather than four pages — list, create, edit and
	one skill's body — mirroring KnowledgeManager's `view` switching for the
	same reason: somebody managing skills is doing one task and should not
	lose their place at each step. The dialog language is the MCP one
	(`overlay/styles.ts`); the shape is sparse on purpose, plumbing with a
	face rather than a showcase.

	One component for both surfaces, told apart by a prop: the workspace tab
	manages the person's own skills beside the deployment's read-only rows,
	while `admin` manages the deployment rows themselves — same validation
	rules (frontmatter name+description required, body cap, enforced
	server-side), same endpoints (`POST` with `scope: "deployment"`,
	`PATCH`/`DELETE` by id with the server's admin gate). The delete idiom
	follows the surface: the workspace's two-step arm here, the admin
	panel's `confirm()` there (matching the connectors section).
-->
<script lang="ts">
	import { onMount, untrack } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import Rich from "$lib/i18n/Rich.svelte";
	import IconAddLarge from "~icons/carbon/add-large";
	import IconTrash from "~icons/carbon/trash-can";
	import IconView from "~icons/carbon/view";
	import IconArrowLeft from "~icons/carbon/arrow-left";
	import IconDocument from "~icons/carbon/document";
	import IconUpload from "~icons/carbon/upload";
	import IconFolder from "~icons/carbon/folder";
	import * as s from "$lib/components/overlay/styles";

	interface UserSkill {
		id: string;
		name: string;
		description: string;
		enabled: boolean;
		updatedAt: string;
		/** Bundled `scripts/`/`references/`/`assets/` paths — content fetched per file, on demand. */
		files: string[];
	}

	/**
	 * One deployment-scope row: the same shape as a user skill (it is the
	 * same collection), read-only in the workspace tab and fully manageable
	 * in `admin` mode.
	 */
	type DeploymentSkill = UserSkill;

	interface Props {
		/** Open straight onto one user skill, for `/workspace?tab=skills&id=…`. */
		initialId?: string;
		/**
		 * Manage the deployment's skills rather than the person's own: the
		 * admin panel's Skills section. Same component, because the rows are
		 * the same shape and the endpoints are the same family.
		 */
		admin?: boolean;
	}

	let { initialId, admin = false }: Props = $props();

	type View = "list" | "create" | "edit" | "detail" | "admin" | "import";
	// Read once: `initialId` is the address somebody arrived on. A `$derived`
	// here would drag them back to the detail view every time they navigated
	// to the list inside the manager.
	let view = $state<View>(untrack(() => (initialId ? "detail" : "list")));

	let userSkills = $state<UserSkill[]>([]);
	let adminSkills = $state<DeploymentSkill[]>([]);
	let loading = $state(true);
	let failure = $state<string | null>(null);

	// The create/edit form holds raw SKILL.md text: what is stored is what
	// was typed, frontmatter included, so a skill ports out unchanged.
	let formContent = $state("");
	let formError = $state<string | null>(null);
	let formBusy = $state(false);
	let editing = $state<UserSkill | null>(null);
	// Which list the row being edited came from — the save writes back there.
	let editingDeployment = $state(false);

	// One skill's body, fetched on demand — the list carries frontmatter only.
	let detailName = $state("");
	let detailDescription = $state("");
	let detailContent = $state("");
	let detailFiles = $state<string[]>([]);
	let detailId = $state("");
	let detailLoading = $state(false);
	let detailReadOnly = $state(false);

	// A bundled file's content, fetched and shown inline under its row.
	let openFilePath = $state<string | null>(null);
	let openFileContent = $state("");
	let openFileLoading = $state(false);
	let fileError = $state<string | null>(null);

	// The zip-import form: a file picker plus the same scope the create form uses.
	let importFile = $state<File | null>(null);
	let importError = $state<string | null>(null);
	let importBusy = $state(false);

	// Two-step delete: the first click arms, the second confirms.
	let deleteArmed = $state<string | null>(null);

	const enabledCount = $derived(userSkills.filter((skill) => skill.enabled).length);
	const deploymentEnabledCount = $derived(adminSkills.filter((skill) => skill.enabled).length);

	const PLACEHOLDER = m["skills.manager.form.placeholder"]();

	async function api<T>(
		path: string,
		init?: { method?: string; headers?: Record<string, string>; body?: string | FormData }
	): Promise<T> {
		const response = await fetch(`${base}/api/v2/skills${path}`, init);
		if (!response.ok) {
			const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
			throw new Error(
				parsed?.message ?? m["skills.manager.error_status"]({ status: response.status })
			);
		}
		return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
	}

	function json(body: unknown, method = "POST") {
		return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
	}

	async function load() {
		failure = null;
		try {
			const listed = await api<{ data: { user: UserSkill[]; admin: DeploymentSkill[] } }>("");
			userSkills = listed.data.user;
			adminSkills = listed.data.admin;
		} catch (err) {
			failure = err instanceof Error ? err.message : m["skills.manager.load_failed"]();
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
		editingDeployment = false;
		formContent = "";
		formError = null;
		view = "create";
	}

	async function create() {
		if (!formContent.trim() || formBusy) return;
		formBusy = true;
		formError = null;
		try {
			const created = await api<{ data: UserSkill }>(
				"",
				json(admin ? { content: formContent, scope: "deployment" } : { content: formContent })
			);
			if (admin) {
				adminSkills = [...adminSkills, created.data].sort((a, b) => a.name.localeCompare(b.name));
			} else {
				userSkills = [...userSkills, created.data].sort((a, b) => a.name.localeCompare(b.name));
			}
			view = "list";
		} catch (err) {
			formError = err instanceof Error ? err.message : m["skills.manager.create_failed"]();
		} finally {
			formBusy = false;
		}
	}

	async function openEdit(skill: UserSkill, deployment = false) {
		editing = skill;
		editingDeployment = deployment;
		formError = null;
		formBusy = false;
		try {
			const loaded = await api<{ data: UserSkill & { content: string } }>(`/${skill.id}`);
			formContent = loaded.data.content;
			view = "edit";
		} catch (err) {
			failure = err instanceof Error ? err.message : m["skills.manager.skill_load_failed"]();
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
			if (editingDeployment) {
				adminSkills = adminSkills.map((skill) => (skill.id === editing?.id ? updated.data : skill));
			} else {
				userSkills = userSkills.map((skill) => (skill.id === editing?.id ? updated.data : skill));
			}
			editing = null;
			editingDeployment = false;
			view = "list";
		} catch (err) {
			formError = err instanceof Error ? err.message : m["skills.manager.save_failed"]();
		} finally {
			formBusy = false;
		}
	}

	async function toggle(skill: UserSkill, deployment = false) {
		try {
			const updated = await api<{ data: UserSkill }>(
				`/${skill.id}`,
				json({ enabled: !skill.enabled }, "PATCH")
			);
			if (deployment) {
				adminSkills = adminSkills.map((entry) => (entry.id === skill.id ? updated.data : entry));
			} else {
				userSkills = userSkills.map((entry) => (entry.id === skill.id ? updated.data : entry));
			}
		} catch (err) {
			failure = err instanceof Error ? err.message : m["skills.manager.change_failed"]();
		}
	}

	async function confirmDelete(skill: UserSkill, deployment = false) {
		if (deployment && admin) {
			// The admin panel's idiom: a `confirm()` naming the blast radius,
			// matching the connectors section.
			if (!confirm(m["skills.manager.remove_confirm"]({ name: skill.name }))) {
				return;
			}
			try {
				await api<void>(`/${skill.id}`, { method: "DELETE" });
				adminSkills = adminSkills.filter((entry) => entry.id !== skill.id);
				if (editing?.id === skill.id) {
					editing = null;
					editingDeployment = false;
					view = "list";
				}
			} catch (err) {
				failure = err instanceof Error ? err.message : m["skills.manager.delete_failed"]();
			}
			return;
		}
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
			failure = err instanceof Error ? err.message : m["skills.manager.delete_failed"]();
		}
	}

	async function openDetail(id: string) {
		detailLoading = true;
		detailReadOnly = false;
		openFilePath = null;
		fileError = null;
		try {
			const loaded = await api<{ data: UserSkill & { content: string } }>(`/${id}`);
			detailName = loaded.data.name;
			detailDescription = loaded.data.description;
			detailContent = loaded.data.content;
			detailFiles = loaded.data.files;
			detailId = loaded.data.id;
			view = "detail";
		} catch {
			view = "list";
		} finally {
			detailLoading = false;
		}
	}

	async function openAdmin(id: string) {
		detailLoading = true;
		detailReadOnly = true;
		openFilePath = null;
		fileError = null;
		try {
			const loaded = await api<{
				data: { id: string; name: string; description: string; content: string; files: string[] };
			}>(`/${encodeURIComponent(id)}`);
			detailName = loaded.data.name;
			detailDescription = loaded.data.description;
			detailContent = loaded.data.content;
			detailFiles = loaded.data.files;
			detailId = loaded.data.id;
			view = "admin";
		} catch (err) {
			failure = err instanceof Error ? err.message : m["skills.manager.skill_load_failed"]();
		} finally {
			detailLoading = false;
		}
	}

	/** The rest-param route wants slashes preserved and everything else escaped. */
	function fileUrl(path: string): string {
		return `/${detailId}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
	}

	async function viewFile(path: string) {
		if (openFilePath === path) {
			openFilePath = null;
			return;
		}
		openFilePath = path;
		openFileLoading = true;
		fileError = null;
		try {
			const loaded = await api<{ data: { path: string; content: string; encoding?: string } }>(
				fileUrl(path)
			);
			openFileContent = loaded.data.content;
		} catch (err) {
			fileError = err instanceof Error ? err.message : m["skills.manager.file_load_failed"]();
			openFilePath = null;
		} finally {
			openFileLoading = false;
		}
	}

	async function removeFile(path: string) {
		fileError = null;
		try {
			const updated = await api<{ data: UserSkill }>(fileUrl(path), {
				method: "DELETE",
			});
			detailFiles = updated.data.files;
			if (openFilePath === path) openFilePath = null;
			const list = detailReadOnly ? adminSkills : userSkills;
			const patched = list.map((entry) => (entry.id === detailId ? updated.data : entry));
			if (detailReadOnly) adminSkills = patched;
			else userSkills = patched;
		} catch (err) {
			fileError = err instanceof Error ? err.message : m["skills.manager.file_remove_failed"]();
		}
	}

	function openImport() {
		importFile = null;
		importError = null;
		importBusy = false;
		view = "import";
	}

	async function importZip() {
		if (!importFile || importBusy) return;
		importBusy = true;
		importError = null;
		try {
			const body = new FormData();
			body.append("file", importFile);
			if (admin) body.append("scope", "deployment");
			const created = await api<{ data: UserSkill }>("", { method: "POST", body });
			if (admin) {
				adminSkills = [...adminSkills, created.data].sort((a, b) => a.name.localeCompare(b.name));
			} else {
				userSkills = [...userSkills, created.data].sort((a, b) => a.name.localeCompare(b.name));
			}
			view = "list";
		} catch (err) {
			importError = err instanceof Error ? err.message : m["skills.manager.import_failed"]();
		} finally {
			importBusy = false;
		}
	}

	function back() {
		editing = null;
		editingDeployment = false;
		deleteArmed = null;
		openFilePath = null;
		fileError = null;
		view = "list";
	}
</script>

{#snippet strong(text: string)}<strong>{text}</strong>{/snippet}
{#snippet code(text: string)}<code>{text}</code>{/snippet}

<div class={s.EMBEDDED}>
	<div class="p-6">
		<div class="mb-6">
			<h2 class="mb-1 text-xl font-semibold text-gray-900 dark:text-gray-200">
				{admin ? m["skills.manager.title_admin"]() : m["skills.manager.title"]()}
			</h2>
			<p class="text-sm text-gray-600 dark:text-gray-400">
				{#if admin}
					{m["skills.manager.subtitle_admin"]()}
				{:else}
					{m["skills.manager.subtitle"]()}
				{/if}
			</p>
		</div>

		{#if failure}
			<div class="{s.ERROR} mb-4" role="alert">{failure}</div>
		{/if}

		{#if view === "list"}
			{#if admin}
				<div
					class="mb-6 flex justify-between rounded-lg p-4 max-sm:flex-col max-sm:gap-4 sm:items-center {adminSkills.length
						? 'bg-blue-50 dark:bg-blue-900/10'
						: 'bg-gray-100 dark:bg-white/5'}"
				>
					<div class="flex items-center gap-3">
						<div
							class="flex size-10 items-center justify-center rounded-xl bg-blue-500/10"
							class:grayscale={!adminSkills.length}
						>
							<IconDocument class="size-8 text-blue-600 dark:text-blue-500" />
						</div>
						<div>
							<p class="text-sm font-semibold text-gray-900 dark:text-gray-100">
								{m["skills.manager.admin.count"]({ count: adminSkills.length })}
							</p>
							<p class="text-xs text-gray-600 dark:text-gray-400">
								{m["skills.manager.admin.enabled"]({ count: deploymentEnabledCount })}
							</p>
						</div>
					</div>
					<div class="flex gap-2">
						<button onclick={openImport} class={s.SECONDARY}>
							<IconUpload class="size-4" />
							{m["skills.manager.import_zip"]()}
						</button>
						<button onclick={openCreate} class={s.PRIMARY}>
							<IconAddLarge class="size-4" />
							{m["skills.manager.new_builtin"]()}
						</button>
					</div>
				</div>

				<div class="space-y-5">
					{#if loading}
						<p class="text-sm text-gray-500 dark:text-gray-400">{m["skills.manager.loading"]()}</p>
					{:else if adminSkills.length === 0}
						<div class={s.EMPTY}>
							<IconDocument class={s.EMPTY_ICON} />
							<p class={s.EMPTY_TITLE}>{m["skills.manager.admin.empty_title"]()}</p>
							<p class={s.EMPTY_DETAIL}>
								{m["skills.manager.empty.detail"]()}
							</p>
							<button onclick={openCreate} class={s.PRIMARY}>
								<IconAddLarge class="size-4" />
								{m["skills.manager.new_builtin"]()}
							</button>
						</div>
					{:else}
						<div class={s.GRID}>
							{#each adminSkills as skill (skill.id)}
								<div class={s.card(skill.enabled)}>
									<div class={s.CARD_BODY}>
										<div class="flex items-start justify-between gap-2">
											<div class="min-w-0">
												<p class={s.CARD_TITLE}>{skill.name}</p>
												<p class={s.CARD_SUBTITLE}>{skill.description}</p>
												{#if skill.files.length > 0}
													<p
														class="mt-0.5 flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400"
													>
														<IconFolder class="size-3.5" />
														{m["skills.manager.bundled_files"]({ count: skill.files.length })}
													</p>
												{/if}
											</div>
											<span class="{s.PILL} {s.PILL_TONES[skill.enabled ? 'good' : 'neutral']}">
												{skill.enabled ? m["skills.manager.on"]() : m["skills.manager.off"]()}
											</span>
										</div>
										<div class="mt-3 flex flex-wrap gap-1.5">
											<button onclick={() => void openDetail(skill.id)} class={s.CARD_ACTION}>
												<IconView class="size-3.5" />
												{m["skills.manager.view"]()}
											</button>
											<button onclick={() => void toggle(skill, true)} class={s.CARD_ACTION}>
												{skill.enabled
													? m["skills.manager.disable"]()
													: m["skills.manager.enable"]()}
											</button>
											<button onclick={() => void openEdit(skill, true)} class={s.CARD_ACTION}
												>{m["skills.manager.edit"]()}</button
											>
											<button
												onclick={() => void confirmDelete(skill, true)}
												class={s.CARD_DESTRUCTIVE}
											>
												<IconTrash class="size-3.5" />
												{m["skills.manager.delete"]()}
											</button>
										</div>
									</div>
								</div>
							{/each}
						</div>
					{/if}

					<div class={s.TIPS}>
						<h4 class={s.TIPS_TITLE}>{m["skills.manager.tips.title"]()}</h4>
						<ul class={s.TIPS_LIST}>
							<li>{m["skills.manager.tips.admin.off"]()}</li>
							<li>{m["skills.manager.tips.admin.override"]()}</li>
							<li>{m["skills.manager.tips.python"]()}</li>
							<li>{m["skills.manager.tips.import"]()}</li>
						</ul>
					</div>
				</div>
			{:else}
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
								{m["skills.manager.user.count"]({ count: userSkills.length })}
							</p>
							<p class="text-xs text-gray-600 dark:text-gray-400">
								{m["skills.manager.user.enabled"]({
									enabled: enabledCount,
									builtin: adminSkills.length,
								})}
							</p>
						</div>
					</div>
					<div class="flex gap-2">
						<button onclick={openImport} class={s.SECONDARY}>
							<IconUpload class="size-4" />
							{m["skills.manager.import_zip"]()}
						</button>
						<button onclick={openCreate} class={s.PRIMARY}>
							<IconAddLarge class="size-4" />
							{m["skills.manager.new_skill"]()}
						</button>
					</div>
				</div>

				<div class="space-y-5">
					{#if loading}
						<p class="text-sm text-gray-500 dark:text-gray-400">{m["skills.manager.loading"]()}</p>
					{:else}
						{#if userSkills.length === 0}
							<div class={s.EMPTY}>
								<IconDocument class={s.EMPTY_ICON} />
								<p class={s.EMPTY_TITLE}>{m["skills.manager.empty.title"]()}</p>
								<p class={s.EMPTY_DETAIL}>
									{m["skills.manager.empty.detail"]()}
								</p>
								<button onclick={openCreate} class={s.PRIMARY}>
									<IconAddLarge class="size-4" />
									{m["skills.manager.new_skill"]()}
								</button>
							</div>
						{:else}
							<div>
								<h3 class={s.SECTION_TITLE}>
									{m["skills.manager.user.heading"]({ count: userSkills.length })}
								</h3>
								<div class={s.GRID}>
									{#each userSkills as skill (skill.id)}
										<div class={s.card(skill.enabled)}>
											<div class={s.CARD_BODY}>
												<div class="flex items-start justify-between gap-2">
													<div class="min-w-0">
														<p class={s.CARD_TITLE}>{skill.name}</p>
														<p class={s.CARD_SUBTITLE}>{skill.description}</p>
														{#if skill.files.length > 0}
															<p
																class="mt-0.5 flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400"
															>
																<IconFolder class="size-3.5" />
																{m["skills.manager.bundled_files"]({ count: skill.files.length })}
															</p>
														{/if}
													</div>
													<span class="{s.PILL} {s.PILL_TONES[skill.enabled ? 'good' : 'neutral']}">
														{skill.enabled ? m["skills.manager.on"]() : m["skills.manager.off"]()}
													</span>
												</div>
												<div class="mt-3 flex flex-wrap gap-1.5">
													<button onclick={() => void openDetail(skill.id)} class={s.CARD_ACTION}>
														<IconView class="size-3.5" />
														{m["skills.manager.view"]()}
													</button>
													<button onclick={() => void toggle(skill)} class={s.CARD_ACTION}>
														{skill.enabled
															? m["skills.manager.disable"]()
															: m["skills.manager.enable"]()}
													</button>
													<button onclick={() => void openEdit(skill)} class={s.CARD_ACTION}
														>{m["skills.manager.edit"]()}</button
													>
													<button
														onclick={() => void confirmDelete(skill)}
														class={s.CARD_DESTRUCTIVE}
													>
														<IconTrash class="size-3.5" />
														{deleteArmed === skill.id
															? m["skills.manager.confirm_delete"]()
															: m["skills.manager.delete"]()}
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
									{m["skills.manager.builtin.heading"]({ count: adminSkills.length })}
								</h3>
								<div class={s.GRID}>
									{#each adminSkills as skill (skill.id)}
										<div class={s.card(false)}>
											<div class={s.CARD_BODY}>
												<div class="flex items-start justify-between gap-2">
													<div class="min-w-0">
														<p class={s.CARD_TITLE}>{skill.name}</p>
														<p class={s.CARD_SUBTITLE}>{skill.description}</p>
													</div>
													<span class="{s.PILL} {s.PILL_TONES.neutral}"
														>{m["skills.manager.builtin.pill"]()}</span
													>
												</div>
												<div class="mt-3 flex flex-wrap gap-1.5">
													<button onclick={() => void openAdmin(skill.id)} class={s.CARD_ACTION}>
														<IconView class="size-3.5" />
														{m["skills.manager.view"]()}
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
						<h4 class={s.TIPS_TITLE}>{m["skills.manager.tips.title"]()}</h4>
						<ul class={s.TIPS_LIST}>
							<li>{m["skills.manager.tips.mention"]()}</li>
							<li>{m["skills.manager.tips.auto"]()}</li>
							<li>{m["skills.manager.tips.python"]()}</li>
							<li>{m["skills.manager.tips.builtin"]()}</li>
							<li>{m["skills.manager.tips.import"]()}</li>
						</ul>
					</div>
				</div>
			{/if}
		{:else if view === "create" || view === "edit"}
			<div class="mb-4">
				<button onclick={back} class={s.CARD_ACTION}>
					<IconArrowLeft class="size-3.5" />
					{m["skills.manager.back"]()}
				</button>
			</div>
			<h3 class="mb-1 text-base font-semibold text-gray-900 dark:text-gray-100">
				{view === "create"
					? admin
						? m["skills.manager.new_builtin"]()
						: m["skills.manager.new_skill"]()
					: m["skills.manager.edit_title"]({
							name: editing?.name ?? m["skills.manager.edit_fallback"](),
						})}
			</h3>
			<p class="mb-4 text-sm text-gray-600 dark:text-gray-400">
				<Rich
					parts={m["skills.manager.form.description"].parts({
						name: "name",
						description: "description",
					})}
					tags={{ code }}
				/>
				{#if admin}{m["skills.manager.form.admin_saved"]()}{/if}
			</p>
			{#if formError}
				<div class="{s.ERROR} mb-4" role="alert">{formError}</div>
			{/if}
			<label class={s.LABEL} for="skill-content">{m["skills.manager.form.file_label"]()}</label>
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
						{formBusy
							? m["skills.manager.form.creating"]()
							: admin
								? m["skills.manager.form.create_builtin"]()
								: m["skills.manager.form.create"]()}
					</button>
				{:else}
					<button
						onclick={() => void saveEdit()}
						disabled={formBusy || !formContent.trim()}
						class={s.PRIMARY}
					>
						{formBusy ? m["skills.manager.form.saving"]() : m["skills.manager.form.save_changes"]()}
					</button>
				{/if}
				<button onclick={back} class={s.SECONDARY}>{m["skills.manager.cancel"]()}</button>
			</div>
		{:else if view === "import"}
			<div class="mb-4">
				<button onclick={back} class={s.CARD_ACTION}>
					<IconArrowLeft class="size-3.5" />
					{m["skills.manager.back"]()}
				</button>
			</div>
			<h3 class="mb-1 text-base font-semibold text-gray-900 dark:text-gray-100">
				{admin ? m["skills.manager.import.title_admin"]() : m["skills.manager.import.title"]()}
			</h3>
			<p class="mb-4 text-sm text-gray-600 dark:text-gray-400">
				<Rich
					parts={m["skills.manager.import.description"].parts({
						skill: "SKILL.md",
						scripts: "scripts/",
						references: "references/",
						assets: "assets/",
					})}
					tags={{ code }}
				/>
				{#if admin}{m["skills.manager.import.admin_imported"]()}{/if}
			</p>
			{#if importError}
				<div class="{s.ERROR} mb-4" role="alert">{importError}</div>
			{/if}
			<label class={s.LABEL} for="skill-zip">{m["skills.manager.import.zip_label"]()}</label>
			<input
				id="skill-zip"
				type="file"
				accept=".zip"
				onchange={(event) => {
					importFile = event.currentTarget.files?.[0] ?? null;
				}}
				class="{s.INPUT} file:mr-3 file:rounded-lg file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm file:font-medium dark:file:bg-gray-700 dark:file:text-gray-200"
			/>
			<div class="mt-4 flex gap-2">
				<button
					onclick={() => void importZip()}
					disabled={importBusy || !importFile}
					class={s.PRIMARY}
				>
					<IconUpload class="size-4" />
					{importBusy
						? m["skills.manager.import.importing"]()
						: admin
							? m["skills.manager.import.button_admin"]()
							: m["skills.manager.import.button"]()}
				</button>
				<button onclick={back} class={s.SECONDARY}>{m["skills.manager.cancel"]()}</button>
			</div>
		{:else}
			<div class="mb-4">
				<button onclick={back} class={s.CARD_ACTION}>
					<IconArrowLeft class="size-3.5" />
					{m["skills.manager.back"]()}
				</button>
			</div>
			{#if detailLoading}
				<p class="text-sm text-gray-500 dark:text-gray-400">
					{m["skills.manager.detail.loading"]()}
				</p>
			{:else}
				<div class="mb-2 flex items-center gap-2">
					<h3 class="text-base font-semibold text-gray-900 dark:text-gray-100">{detailName}</h3>
					{#if detailReadOnly}
						<span class="{s.PILL} {s.PILL_TONES.neutral}"
							>{m["skills.manager.detail.read_only"]()}</span
						>
					{/if}
				</div>
				<p class="mb-4 text-sm text-gray-600 dark:text-gray-400">{detailDescription}</p>
				<pre
					class="scrollbar-custom max-h-[32rem] overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-4 font-mono text-xs whitespace-pre-wrap text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">{detailContent}</pre>

				{#if detailFiles.length > 0}
					<div class="mt-4">
						<h4 class="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
							{m["skills.manager.detail.files"]({ count: detailFiles.length })}
						</h4>
						{#if fileError}
							<div class="{s.ERROR} mb-2" role="alert">{fileError}</div>
						{/if}
						<div class="space-y-1.5">
							{#each detailFiles as path (path)}
								<div class="rounded-lg border border-gray-200 dark:border-gray-700">
									<div class="flex items-center justify-between gap-2 px-3 py-2">
										<span class="truncate font-mono text-xs text-gray-700 dark:text-gray-300"
											>{path}</span
										>
										<div class="flex shrink-0 gap-1.5">
											<button onclick={() => void viewFile(path)} class={s.CARD_ACTION}>
												<IconView class="size-3.5" />
												{openFilePath === path
													? m["skills.manager.detail.hide"]()
													: m["skills.manager.view"]()}
											</button>
											{#if !detailReadOnly}
												<button onclick={() => void removeFile(path)} class={s.CARD_DESTRUCTIVE}>
													<IconTrash class="size-3.5" />
													{m["skills.manager.detail.remove"]()}
												</button>
											{/if}
										</div>
									</div>
									{#if openFilePath === path}
										<div class="border-t border-gray-200 px-3 py-2 dark:border-gray-700">
											{#if openFileLoading}
												<p class="text-xs text-gray-500 dark:text-gray-400">
													{m["skills.manager.detail.file_loading"]()}
												</p>
											{:else}
												<pre
													class="scrollbar-custom max-h-64 overflow-auto text-xs whitespace-pre-wrap text-gray-800 dark:text-gray-200">{openFileContent}</pre>
											{/if}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{/if}
			{/if}
		{/if}
	</div>
</div>
