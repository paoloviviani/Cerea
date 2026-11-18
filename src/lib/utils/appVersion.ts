/**
 * Cerea's version, from package.json at build time (`define` in
 * vite.config.ts). A build constant rather than runtime config: the image's
 * runtime env does not carry it (PUBLIC_VERSION is only set under `npm run`).
 */
export const APP_VERSION: string = __APP_VERSION__;

/** The last Cerea release that changed galopin (`agent/LAST_CHANGED`). A computer whose galopin is
 * older than this is behind; a newer Cerea alone does not make it so. */
export const GALOPIN_LAST_CHANGED: string = __GALOPIN_LAST_CHANGED__;

/**
 * The oldest galopin this Cerea still works with. A computer below it gets the strong "update
 * needed" warning, one at or above it but below GALOPIN_LAST_CHANGED the soft "update available"
 * hint. Raise it by hand (to that release's version) in the same change that drops support for
 * an older galopin, e.g. when a protocol field it lacks becomes required.
 */
export const MIN_SUPPORTED_GALOPIN = "0.1.0";
