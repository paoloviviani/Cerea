/**
 * What a model's title must survive before it names a chat. A title model
 * sometimes leaks its own control tokens (`<|start|>assistant<|channel|>`),
 * answers the message instead of titling it ("I'm unable to execute code…"),
 * wraps the title in quotes, runs long, or writes in another language than the
 * user did. Anything that cannot be repaired is refused (undefined) so the
 * caller falls back to the trimmed first sentence of the user's message.
 */

/** The longest a title gets, in words. */
export const TITLE_MAX_WORDS = 6;
const TITLE_MAX_CHARS = 60;

/** Openings of a reply or a refusal rather than a title. */
const REFUSAL =
	/^(i['’]?m\s+(unable|sorry|not able|afraid)|i\s+(am\s+)?(unable|cannot|can['’]?t|won['’]?t)|i\s+(do not|don['’]?t)\s+(have|know)|sorry\b|as an ai\b|unfortunately\b|certainly\b|sure[,!]|here (is|are)\b|mi dispiace\b|non posso\b|purtroppo\b|scusa\b|spiacente\b)/i;

const EN_WORDS = new Set(
	"the a an of to and is are for in on with what how why can you i me my this that it do does please about from".split(
		" "
	)
);
const IT_WORDS = new Set(
	"il lo la le gli un una di che e è sono per con come cosa perché puoi posso mi mio questo questa del della dei nel nella fra tra".split(
		" "
	)
);

function words(text: string): string[] {
	return text.toLowerCase().match(/\p{L}+/gu) ?? [];
}

/** "en" or "it" only when the text clearly reads as one; null when unsure. */
function latinLanguage(text: string): "en" | "it" | null {
	const ws = words(text);
	if (ws.length < 3) return null;
	const en = ws.filter((w) => EN_WORDS.has(w)).length;
	const it = ws.filter((w) => IT_WORDS.has(w)).length;
	if (en >= 2 && en >= it * 2) return "en";
	if (it >= 2 && it >= en * 2) return "it";
	return null;
}

const NON_LATIN =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hangul}]/u;

/** True when the title is plainly in another language than the user's message. */
function languageMismatch(title: string, userMessage: string): boolean {
	if (NON_LATIN.test(title) !== NON_LATIN.test(userMessage)) return true;
	const wanted = latinLanguage(userMessage);
	const got = latinLanguage(title);
	return wanted !== null && got !== null && wanted !== got;
}

export function sanitiseTitle(raw: string, userMessage = ""): string | undefined {
	let t = raw
		// `<|start|>`, `<|channel|>` and anything else between `<|` and `|>`.
		.replace(/<\|[^|>]*\|>/g, " ")
		// A channel name left stuck to a stripped token ("assistant", "final", "analysis").
		.replace(/^\s*(assistant|final|analysis|commentary)\b[\s:]*/i, "")
		.replace(/<\/?[a-z_]+>/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	// Quotes, markdown emphasis and a leading "Title:" label.
	const unquote = (x: string) => x.replace(/^[\s"'“”‘’«»`*_#]+|[\s"'“”‘’«»`*_#]+$/g, "").trim();
	t = unquote(unquote(t).replace(/^(title|titolo)\s*:\s*/i, ""));
	if (!t || REFUSAL.test(t)) return undefined;
	if (userMessage && languageMismatch(t, userMessage)) return undefined;

	const ws = t.split(" ");
	if (ws.length > TITLE_MAX_WORDS) t = ws.slice(0, TITLE_MAX_WORDS).join(" ");
	t = t.replace(/[\s,;:.!?…-]+$/u, "");
	if (t.length > TITLE_MAX_CHARS) t = t.slice(0, TITLE_MAX_CHARS).replace(/\s\S*$/u, "");
	return t || undefined;
}
