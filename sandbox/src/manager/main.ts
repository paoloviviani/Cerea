import { loadConfig, ConfigError } from "./config.ts";
import { FileAudit } from "./audit.ts";
import { DockerClient } from "./docker.ts";
import { LeaseManager } from "./leases.ts";
import { createApi } from "./api.ts";
import { logLine } from "../shared/http.ts";

async function main() {
	let config;
	try {
		config = loadConfig();
	} catch (err) {
		if (err instanceof ConfigError) {
			logLine({ level: "fatal", msg: err.message });
			process.exit(2);
		}
		throw err;
	}
	if (config.runtime === "runc") {
		logLine({
			level: "warn",
			msg: "SANDBOX_RUNTIME=runc: sandboxes share the host kernel with no user-space kernel in between. Development and tests only; never for real users.",
		});
	}
	if (config.warmPoolSize > 0) {
		logLine({
			level: "warn",
			msg: "SANDBOX_WARM_POOL_SIZE is reserved: the warm pool arrives with step 2, it is ignored now",
		});
	}
	if (config.machinesEnabled) {
		logLine({
			level: "warn",
			msg: "SANDBOX_MACHINES_ENABLED=true, but hosted machines are not built yet: machine leases answer 501",
		});
	}
	const docker = new DockerClient(config.docker);
	const leases = new LeaseManager({ config, docker, audit: new FileAudit(config.auditLog) });

	// A previous run's containers are not ours to keep: their leases are gone. The socket proxy may
	// still be starting, so ask a few times before giving up.
	for (let attempt = 1; attempt <= 10; attempt++) {
		try {
			const n = await leases.sweepOrphans();
			logLine({ level: "info", msg: "orphan sweep", removed: n });
			break;
		} catch (err) {
			if (attempt === 10) {
				logLine({
					level: "error",
					msg: "orphan sweep failed (is the socket proxy up?)",
					error: String(err),
				});
			} else {
				await new Promise((r) => setTimeout(r, 2000));
			}
		}
	}

	const reaper = setInterval(
		() => void leases.reap().catch(() => {}),
		config.reapIntervalSeconds * 1000
	);
	reaper.unref();
	const server = createApi(config, leases);
	server.listen(config.port, config.host, () =>
		logLine({
			level: "info",
			msg: "sandbox manager listening",
			host: config.host,
			port: config.port,
			runtime: config.runtime,
			instance: config.instance,
		})
	);
	const stop = () => {
		clearInterval(reaper);
		server.close();
		void leases.shutdown().finally(() => process.exit(0));
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}

void main();
