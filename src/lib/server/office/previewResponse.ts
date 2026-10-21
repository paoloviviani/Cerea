import { ConversionError, isGotenbergEnabled } from "./gotenberg";
import { getOrCreatePreview, type PreviewRequest } from "./previewStore";

/**
 * The response every preview route answers with. The PDF is typed
 * application/pdf and sent as an attachment under the same "download, never
 * render" headers as the stored files (`downloadFile.attachmentResponse`): the
 * client reads the bytes with `fetch` and frames them itself.
 *
 * `404` when the deployment has no converter, so a client that asks anyway
 * learns "no preview" rather than "error".
 */
export async function previewResponse(request: PreviewRequest): Promise<Response> {
	if (!isGotenbergEnabled()) return json(404, "Previews are not enabled.");
	try {
		const { pdf } = await getOrCreatePreview(request);
		return new Response(new Uint8Array(pdf), {
			headers: {
				"Content-Type": "application/pdf",
				"Content-Security-Policy":
					"default-src 'none'; script-src 'none'; style-src 'none'; sandbox;",
				"X-Content-Type-Options": "nosniff",
				"Content-Disposition": 'attachment; filename="preview.pdf"',
				"Content-Length": pdf.byteLength.toString(),
				"Cache-Control": "private, no-store",
			},
		});
	} catch (err) {
		if (err instanceof ConversionError) {
			const status =
				err.kind === "unsupported"
					? 415
					: err.kind === "too_large"
						? 413
						: err.kind === "rejected"
							? 422
							: err.kind === "timeout"
								? 504
								: err.kind === "busy"
									? 503
									: 502;
			return json(status, err.message);
		}
		throw err;
	}
}

function json(status: number, message: string): Response {
	return new Response(JSON.stringify({ message }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
