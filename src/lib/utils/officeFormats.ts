/**
 * Which file extensions count as "an Office document" for previews and the
 * convert_document tool: what Gotenberg's LibreOffice route takes and a person
 * would call a document (text documents, spreadsheets, presentations,
 * drawings). Not images, PDF, plain text, HTML, XML or SVG — those have their
 * own previews. One list for the server (`server/office/gotenberg.ts`) and the
 * browser (`filePreview.ts`), so the two cannot disagree about a name.
 */
const WORD_PROCESSING = [
	"doc",
	"docx",
	"docm",
	"dot",
	"dotx",
	"dotm",
	"odt",
	"ott",
	"fodt",
	"rtf",
	"wpd",
	"wps",
	"pages",
];
const SPREADSHEETS = [
	"xls",
	"xlsx",
	"xlsm",
	"xlsb",
	"xlt",
	"xltx",
	"xltm",
	"ods",
	"ots",
	"fods",
	"numbers",
];
const PRESENTATIONS = [
	"ppt",
	"pptx",
	"pptm",
	"pot",
	"potx",
	"potm",
	"pps",
	"odp",
	"otp",
	"fodp",
	"key",
];
const DRAWINGS = ["odg", "vsd", "vsdx", "pub"];

export const OFFICE_EXTENSIONS: ReadonlySet<string> = new Set([
	...WORD_PROCESSING,
	...SPREADSHEETS,
	...PRESENTATIONS,
	...DRAWINGS,
]);

/** Lower-cased extension without the dot; "" when there is none. */
export function extensionOf(name: string): string {
	const base = name.split("/").pop() ?? name;
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function isOfficeDocument(name: string): boolean {
	return OFFICE_EXTENSIONS.has(extensionOf(name));
}
