/**
 * Who is driving, as the Cerea desktop app says it: a long-lived GET on the same Unix socket and
 * secret as the CDP endpoint (`/ctl/<secret>`), answered with one `data: {"mode":"agent"|"user"}`
 * line now and one on every change. When the stream ends the user is taken to be NOT driving: the
 * app is gone, and a runtime must not hold forever for someone who cannot hand back.
 */
import http from "node:http";

export function parseEndpoint(
	endpoint: string
): { socketPath: string; secret: string } | undefined {
	const m = /^ws\+unix:\/\/(.+):\/cdp\/([A-Za-z0-9_-]+)$/.exec(endpoint.trim());
	return m ? { socketPath: m[1], secret: m[2] } : undefined;
}

export interface Watch {
	close(): void;
}

export function watchControl(
	endpoint: string,
	onMode: (mode: "agent" | "user") => void,
	retryMs = 1000
): Watch | undefined {
	const target = parseEndpoint(endpoint);
	if (!target) return undefined;
	let closed = false;
	let req: http.ClientRequest | undefined;
	let timer: NodeJS.Timeout | undefined;
	const connect = () => {
		if (closed) return;
		req = http.request(
			{ socketPath: target.socketPath, path: `/ctl/${target.secret}`, method: "GET" },
			(res) => {
				if (res.statusCode !== 200) {
					res.resume();
					return;
				}
				res.setEncoding("utf8");
				let buf = "";
				res.on("data", (chunk: string) => {
					buf += chunk;
					for (;;) {
						const end = buf.indexOf("\n\n");
						if (end < 0) break;
						const block = buf.slice(0, end);
						buf = buf.slice(end + 2);
						const line = block.split("\n").find((l) => l.startsWith("data: "));
						if (!line) continue;
						try {
							const mode = (JSON.parse(line.slice(6)) as { mode?: unknown }).mode;
							if (mode === "agent" || mode === "user") onMode(mode);
						} catch {
							// a line that is not ours
						}
					}
				});
				res.on("end", lost);
				res.on("error", lost);
			}
		);
		req.on("error", lost);
		req.end();
	};
	const lost = () => {
		if (closed) return;
		onMode("agent");
		clearTimeout(timer);
		timer = setTimeout(connect, retryMs);
		timer.unref();
	};
	connect();
	return {
		close() {
			closed = true;
			clearTimeout(timer);
			req?.destroy();
		},
	};
}
