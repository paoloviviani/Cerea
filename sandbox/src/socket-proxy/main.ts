import { createProxy } from "./server.ts";
import { isSliceName } from "../shared/slice.ts";
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
const cgroupParent = (process.env.SANDBOX_CGROUP_PARENT ?? "").trim() || undefined;
if (cgroupParent !== undefined && !isSliceName(cgroupParent)) {
	logLine({
		level: "fatal",
		msg: "SANDBOX_CGROUP_PARENT is not a systemd slice name (such as cerea-sandbox.slice)",
	});
	process.exit(2);
}
const maxCpus = Number(process.env.SANDBOX_EXEC_MAX_CPUS || 2);
if (!(maxCpus > 0)) {
	logLine({ level: "fatal", msg: "SANDBOX_EXEC_MAX_CPUS must be a positive number" });
	process.exit(2);
}
const runtimes = runtime === "runc" && allowRunc ? ["runc"] : ["runsc"];
const port = Number(process.env.SANDBOX_PROXY_PORT || 2375);
const socketPath = process.env.SANDBOX_DOCKER_SOCKET || "/var/run/docker.sock";

createProxy({ socketPath }, { instance, runtimes, images, cgroupParent, maxCpus }).listen(
	port,
	"0.0.0.0",
	() =>
		logLine({
			level: "info",
			msg: "sandbox socket proxy listening",
			port,
			instance,
			runtimes,
			images: images.length,
			cgroupParent: cgroupParent ?? null,
		})
);
