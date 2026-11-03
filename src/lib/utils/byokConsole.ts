/**
 * Where the gateway console lets a user manage their own providers and models
 * (gateway BYOK). The console is served on this origin at `/console` (the same
 * base the admin panel links to); the `/me/providers` page is the contract with
 * the gateway. If the console moves this page, change it here only.
 */
export const BYOK_CONSOLE_PATH = "/console/me/providers";
