import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServerInfo } from "../shared/ipc.ts";
import { normalizeAddress, ServerError } from "./server.ts";

export interface Config {
	server: ServerInfo | null;
}

export function configPath(userData: string): string {
	return join(userData, "config.json");
}

/** Reads the settings. A stored address is re-checked, so a hand-edited file cannot widen the origin. */
export function loadConfig(userData: string): Config {
	try {
		const raw = JSON.parse(readFileSync(configPath(userData), "utf8")) as {
			server?: Partial<ServerInfo>;
		};
		const s = raw.server;
		if (s && typeof s.address === "string") {
			const address = normalizeAddress(s.address);
			return {
				server: {
					address,
					origin: new URL(address).origin,
					idp: typeof s.idp === "string" ? s.idp : new URL(address).origin,
					name: typeof s.name === "string" ? s.name.slice(0, 80) : new URL(address).host,
					...(typeof s.icon === "string" && safeIcon(s.icon) ? { icon: s.icon } : {}),
				},
			};
		}
	} catch (e) {
		if (!(e instanceof ServerError) && (e as NodeJS.ErrnoException).code !== "ENOENT") {
			// a damaged file: start from the first-run screen
		}
	}
	return { server: null };
}

export function saveConfig(userData: string, c: Config): void {
	const file = configPath(userData);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	writeFileSync(file, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
	chmodSync(file, 0o600);
}

/** A stored icon is only ever a small base64 image, never a URL the window would fetch. */
export function safeIcon(icon: string): boolean {
	return (
		/^data:image\/(png|jpeg|webp|gif|x-icon);base64,[A-Za-z0-9+/=]+$/.test(icon) &&
		icon.length < 300_000
	);
}
