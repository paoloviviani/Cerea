/**
 * Render social-preview.html to docs/assets/social-preview.png (1280x640, GitHub's size):
 *
 *   node scripts/docs-screenshots/social-preview.mjs
 *
 * GitHub has no API for the repository's social preview: upload the PNG by hand under
 * Settings -> General -> Social preview.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const html = fileURLToPath(new URL("social-preview.html", import.meta.url));
const out = fileURLToPath(new URL("../../docs/assets/social-preview.png", import.meta.url));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.goto(pathToFileURL(html).href);
await page.waitForLoadState("networkidle");
await page.screenshot({ path: out });
await browser.close();
console.log(out);
