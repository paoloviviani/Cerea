/**
 * Cerea's version, from package.json at build time (`define` in
 * vite.config.ts). A build constant rather than runtime config: the image's
 * runtime env does not carry it (PUBLIC_VERSION is only set under `npm run`).
 */
export const APP_VERSION: string = __APP_VERSION__;
