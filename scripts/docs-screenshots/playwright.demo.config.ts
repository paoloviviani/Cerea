/** The docs-screenshots stack, running demo.spec.ts (the README animation) instead of shots.spec.ts. */
import { defineConfig } from "playwright/test";
import base from "./playwright.config.ts";

export default defineConfig({ ...base, testMatch: /demo\.spec\.ts/ });
