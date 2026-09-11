import { error } from "@sveltejs/kit";
import { logger } from "$lib/server/logger.js";
import { isValidUrl, ssrfSafeFetch } from "$lib/server/urlSafety";
import { configuredBackend, fetchPage } from "$lib/server/fetching";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const FETCH_TIMEOUT = 30000; // 30 seconds
const MAX_REDIRECTS = 5;
const SECURITY_HEADERS: HeadersInit = {
	// Prevent any active content from executing if someone navigates directly to this endpoint.
	"Content-Security-Policy":
		"default-src 'none'; frame-ancestors 'none'; sandbox; script-src 'none'; img-src 'none'; style-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "no-referrer",
};

export async function GET({ url }) {
	const targetUrl = url.searchParams.get("url");

	if (!targetUrl) {
		logger.warn("Missing 'url' parameter");
		throw error(400, "Missing 'url' parameter");
	}

	if (!isValidUrl(targetUrl)) {
		logger.warn({ targetUrl }, "Invalid or unsafe URL (only HTTPS is supported)");
		throw error(400, "Invalid or unsafe URL (only HTTPS is supported)");
	}

	// Fetch with timeout, following redirects manually to validate each hop
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

	let currentUrl = targetUrl;
	let response: Response;
	let redirectCount = 0;

	try {
		// eslint-disable-next-line no-constant-condition
		while (true) {
			response = await ssrfSafeFetch(currentUrl, {
				signal: controller.signal,
				redirect: "manual",
				headers: {
					"User-Agent": "HuggingChat-Attachment-Fetcher/1.0",
				},
			});

			if (response.status >= 300 && response.status < 400) {
				redirectCount++;
				if (redirectCount > MAX_REDIRECTS) {
					throw error(502, "Too many redirects");
				}

				const location = response.headers.get("location");
				if (!location) {
					throw error(502, "Redirect without Location header");
				}

				// Resolve relative redirects against the current URL
				const redirectUrl = new URL(location, currentUrl).toString();

				if (!isValidUrl(redirectUrl)) {
					logger.warn(
						{ redirectUrl, originalUrl: targetUrl },
						"Redirect to unsafe URL blocked (SSRF)"
					);
					throw error(403, "Redirect target is not allowed");
				}

				currentUrl = redirectUrl;
				continue;
			}

			break;
		}
	} finally {
		clearTimeout(timeoutId);
	}

	if (!response.ok) {
		logger.error({ targetUrl, response }, "Error fetching URL. Response not ok.");
		throw error(response.status, `Failed to fetch: ${response.statusText}`);
	}

	// Check content length if available
	const contentLength = response.headers.get("content-length");
	if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
		throw error(413, "File too large (max 10MB)");
	}

	// Stream the response back
	const originalContentType = response.headers.get("content-type") || "application/octet-stream";

	// If an administrator has chosen a renderer, use it — but **only for HTML**.
	// This endpoint fetches attachments of every kind, and a PDF or a .docx put
	// through a browser is at best a waste and at worst a different file. The
	// byte-streaming path below is therefore untouched; the renderer is an
	// alternative for the one content type where "what the server sent" and
	// "what a person would see" differ.
	if (originalContentType.includes("text/html") && configuredBackend() !== "direct") {
		try {
			const rendered = await fetchPage(currentUrl);
			logger.info({ url: currentUrl, backend: rendered.backend }, "fetch_url_rendered");
			return new Response(rendered.content, {
				headers: {
					"Content-Type": "text/plain; charset=utf-8",
					"X-Forwarded-Content-Type": originalContentType,
					"X-Fetch-Backend": rendered.backend,
					"Cache-Control": "public, max-age=3600",
					...SECURITY_HEADERS,
				},
			});
		} catch (err) {
			// Logged, then fall through to the bytes already in hand. Failing the
			// attachment instead would make a renderer outage look like a broken
			// link, and an unrendered page is a worse answer rather than none.
			logger.warn({ err, url: currentUrl }, "fetch_url_render_failed_using_raw");
		}
	}

	// Send as text/plain for safety; expose the original type via secondary header
	const safeContentType = "text/plain; charset=utf-8";
	const contentDisposition = response.headers.get("content-disposition");

	const headers: HeadersInit = {
		"Content-Type": safeContentType,
		"X-Forwarded-Content-Type": originalContentType,
		"Cache-Control": "public, max-age=3600",
		...(contentDisposition ? { "Content-Disposition": contentDisposition } : {}),
		...SECURITY_HEADERS,
	};

	// Get the body as array buffer to check size
	const arrayBuffer = await response.arrayBuffer();

	if (arrayBuffer.byteLength > MAX_FILE_SIZE) {
		throw error(413, "File too large (max 10MB)");
	}

	return new Response(arrayBuffer, { headers });
}
