/**
 * Which account a request should be billed to, as a header.
 *
 * The one place in this application that knows how the gateway spells it. The
 * rest of the code keeps its own vocabulary — `billingOrganization` in user
 * settings, in `App.Locals`, in the settings UI — because this application has
 * to stay viable against something other than Pystino, and a client that names
 * a product in order to say "bill this to that account" is welded to one
 * server.
 *
 * Upstream sends `X-HF-Bill-To`, which is HuggingFace's spelling of the same
 * idea. Pystino's is `x-bill-to`: the concept is not vendor-specific and
 * neither is the name, so a third gateway could honour it unchanged
 * (ADR 0061).
 */

/** The header name the configured gateway expects. */
export const BILL_TO_HEADER = "x-bill-to";

/**
 * The bill-to header for this request, or nothing.
 *
 * Absent rather than empty when unset: the gateway treats a blank value as
 * "no preference", but sending a header nobody asked for makes the request
 * harder to read in a log for no gain.
 */
export function billToHeader(billingOrganization: string | undefined): Record<string, string> {
	const value = billingOrganization?.trim();
	return value ? { [BILL_TO_HEADER]: value } : {};
}
