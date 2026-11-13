/**
 * A `Content-Disposition: attachment` value for any file name. A header value must be Latin-1, so
 * a name with other characters (an accent in a Greek or Chinese file name a model chose) cannot go
 * in `filename="..."` as it is: that throws when the header is set. The plain `filename` is an ASCII
 * fallback with anything unsafe replaced, and `filename*` carries the real name, RFC 5987 encoded.
 */
export function attachmentDisposition(name: string): string {
	// eslint-disable-next-line no-control-regex -- control bytes are valid header-injection attacks
	const ascii = name.replace(/[^\x20-\x7e]|["\\/;]/g, "_").trim() || "download";
	const encoded = encodeURIComponent(name).replace(
		/['()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
	);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
