import { createProxy } from "./server.ts";
import { logLine } from "../shared/http.ts";

const instance = (process.env.SANDBOX_INSTANCE || "cerea").trim();
const runtime = (process.env.SANDBOX_RUNTIME || "runsc").trim();
const allowRunc = (process.env.SANDBOX_ALLOW_RUNC ?? "").trim().toLowerCase() === "true";
const images = (process.env.SANDBOX_ALLOWED_IMAGES ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
if (images.length === 0) {
	logLine({
		level: "fatal",
		msg: "SANDBOX_ALLOWED_IMAGES is empty: the proxy would refuse every sandbox",
	});
	process.exit(2);
}
const runtimes = runtime === "runc" && allowRunc ? ["runc"] : ["runsc"];
const port = Number(process.env.SANDBOX_PROXY_PORT || 2375);
const socketPath = process.env.SANDBOX_DOCKER_SOCKET || "/var/run/docker.sock";

createProxy({ socketPath }, { instance, runtimes, images }).listen(port, "0.0.0.0", () =>
	logLine({
		level: "info",
		msg: "sandbox socket proxy listening",
		port,
		instance,
		runtimes,
		images: images.length,
	})
);
