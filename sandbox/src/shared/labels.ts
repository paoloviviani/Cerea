/** Every container the manager creates carries these; everything else is refused. */
export const LABEL_MANAGED = "cerea.sandbox";
export const LABEL_INSTANCE = "cerea.sandbox.instance";
export const LABEL_LEASE = "cerea.sandbox.lease";
export const LABEL_OWNER = "cerea.sandbox.owner";
export const LABEL_KIND = "cerea.sandbox.kind";
export const NAME_PREFIX = "cerea-sbx-";

/** Whether a container's labels say it is this manager instance's. */
export function isManaged(labels: Record<string, string> | null | undefined, instance: string) {
	return labels?.[LABEL_MANAGED] === "1" && labels?.[LABEL_INSTANCE] === instance;
}
