/**
 * The web app manifest, built in code rather than shipped as a static file
 * so every URL it carries derives from the compile-time base path: a static
 * manifest bakes one deployment's base into its `start_url` and icon
 * sources, and serves 404s to any deployment built differently.
 *
 * The `id` is chosen to keep the identity of the static manifest it
 * replaces: that file carried no `id`, so browsers derived one from its
 * `start_url` (`<origin>/chat` on the kit stack). An explicit id that
 * resolves to the same address keeps already-installed apps themselves —
 * their home-screen entry, data and display mode — instead of splitting a
 * second copy into existence.
 */
export interface ManifestIcon {
	src: string;
	sizes: string;
	type: string;
	purpose?: "any" | "maskable";
}

export interface ManifestShortcut {
	name: string;
	short_name: string;
	url: string;
}

export interface WebAppManifest {
	name: string;
	short_name: string;
	description: string;
	id: string;
	start_url: string;
	scope: string;
	display: "standalone";
	display_override: string[];
	background_color: string;
	theme_color: string;
	lang: string;
	dir: "ltr";
	categories: string[];
	icons: ManifestIcon[];
	shortcuts: ManifestShortcut[];
}

export interface ManifestOptions {
	/** The app's display name (`PUBLIC_APP_NAME`, with the deployment's fallback). */
	appName: string;
	/** The compile-time base path: `""` at the origin root, `/chat` on the kit stack. */
	basePath: string;
	/** The asset directory under `static/` (`PUBLIC_APP_ASSETS`). */
	assetDir: string;
	/** Whether the `/code` agents panel is switched on for this deployment. */
	agentsEnabled: boolean;
}

const ICON_SIZES = [36, 48, 72, 96, 128, 144, 192, 256, 512] as const;

/**
 * The light theme's page background — the same colour the `theme-color` meta
 * already reports before the boot script darkens it. The manifest can only
 * carry one static value for the splash and the installed window's initial
 * title bar; the page's runtime meta takes over from there in both themes.
 */
const THEME_COLOR = "#f9fafb";

export function buildWebAppManifest({
	appName,
	basePath,
	assetDir,
	agentsEnabled,
}: ManifestOptions): WebAppManifest {
	const assets = `${basePath}/${assetDir}`;
	const shortcuts: ManifestShortcut[] = [
		{ name: "Chats", short_name: "Chats", url: `${basePath}/chats` },
		{ name: "Projects", short_name: "Projects", url: `${basePath}/projects` },
	];
	// A shortcut to a 404 reads worse than no shortcut: the agents panel is
	// deployment-gated, so it is listed only when the deployment serves it.
	if (agentsEnabled) {
		shortcuts.push({ name: "Agents", short_name: "Agents", url: `${basePath}/code` });
	}

	return {
		name: appName,
		short_name: appName,
		description: "Chat with your own models, projects, knowledge bases and coding agents.",
		id: basePath || "/",
		start_url: `${basePath}/`,
		scope: `${basePath}/`,
		display: "standalone",
		display_override: ["standalone", "minimal-ui"],
		background_color: THEME_COLOR,
		theme_color: THEME_COLOR,
		lang: "en",
		dir: "ltr",
		categories: ["productivity"],
		icons: [
			...ICON_SIZES.map((size): ManifestIcon => ({
				src: `${assets}/icon-${size}x${size}.png`,
				sizes: `${size}x${size}`,
				type: "image/png",
			})),
			{
				src: `${assets}/icon-maskable-512x512.png`,
				sizes: "512x512",
				type: "image/png",
				purpose: "maskable",
			},
		],
		shortcuts,
	};
}
