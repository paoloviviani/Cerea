# Italian glossary (`messages/it.json`)

The choices behind the Italian interface. Translate with these; change a row
here first, then the catalogue. Written for the owner's review.

**Voice.** Informal "tu" (the norm for modern Italian consumer and developer
software: Google, GitHub, Notion, Slack all use it). Sentence case, short
sentences, a verb on buttons in the infinitive or imperative as the English does
("Salva", "Aggiungi", "Elimina"). Same spirit as `docs/writing.md`: plain
words, say what happened and what to do next, no blame. "Users" is "utenti",
never "persone". Prefer the second-person imperative for instructions ("Riprova",
"Controlla l'indirizzo"), the infinitive only for short button labels where the
English is a bare verb and the app already uses the imperative ("Annulla").

**Never translated:** Cerea, Pystino, galopin, opencode, Claude Code, MCP,
reveal.js, Pyodide, OAuth, Markdown, and anything in `{placeholders}`, `code`
markup, commands, paths, env var names, flags (`--allow-free-models`) and URLs.

| English (as the UI says it)            | Italian                                         | Why                                                                                                                                                                                                                                                             |
| -------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| chat (noun)                            | chat (f.)                                       | Invariable, universal. "Le tue chat", "Elimina tutte le chat".                                                                                                                                                                                                  |
| assistant                              | assistente                                      | Direct.                                                                                                                                                                                                                                                         |
| artifact / file / document             | artefatto / file / documento                    | Italian follows the English wording: where the English says "artifact" (Chats → Artifacts, share links, admin storage) the Italian says "artefatto" (the term Italian Anthropic and Google docs use); where English says "file" or "document", so does Italian. |
| connector                              | connettore                                      | Standard in Italian Microsoft/Zapier UIs. "Connettore locale", "connettori integrati" (built-in).                                                                                                                                                               |
| approval / approve / deny / Allow      | approvazione / approva / rifiuta / Consenti     | "Rifiuta" (not "Nega") is the natural opposite of "approva" in dialogs; "Consenti" for a permission.                                                                                                                                                            |
| share link                             | link di condivisione                            | "Link" is the everyday word; "collegamento" reads as bureaucratic.                                                                                                                                                                                              |
| workspace (the Workspace page)         | Workspace                                       | Product-area name, kept as in English (Slack, Notion and Microsoft keep it).                                                                                                                                                                                    |
| workspace (a folder on a computer)     | workspace                                       | Same word, lower case, as the Code area keeps its git vocabulary.                                                                                                                                                                                               |
| agent / Agents                         | agente / Agenti                                 | Direct.                                                                                                                                                                                                                                                         |
| session                                | sessione                                        | Direct. An agent's run, never "conversazione".                                                                                                                                                                                                                  |
| computer (the user's own)              | computer                                        | Never "macchina" or "dispositivo", as in English. "Dispositivo" only for a phone or browser that gets notifications.                                                                                                                                            |
| pair / enroll                          | associare / registrare                          | "Associa un computer" (like Bluetooth pairing). "Registra" for enrol.                                                                                                                                                                                           |
| daemon, worktree, branch, HEAD, commit | kept                                            | Git and Unix words, kept in English as in the docs.                                                                                                                                                                                                             |
| token (a context unit)                 | token                                           | Kept; the standard Italian usage in LLM tooling.                                                                                                                                                                                                                |
| access key / API key                   | chiave di accesso / chiave API                  | Direct.                                                                                                                                                                                                                                                         |
| model                                  | modello                                         | Direct.                                                                                                                                                                                                                                                         |
| provider                               | provider                                        | The Italian IT world keeps "provider"; "fornitore" is used only for the people/companies (rare in the UI).                                                                                                                                                      |
| billing group                          | gruppo di fatturazione                          | Direct.                                                                                                                                                                                                                                                         |
| project                                | progetto                                        | Direct.                                                                                                                                                                                                                                                         |
| knowledge base                         | base di conoscenza                              | The usual Italian rendering (Zendesk, Atlassian).                                                                                                                                                                                                               |
| memory                                 | memoria                                         | Direct.                                                                                                                                                                                                                                                         |
| skill                                  | skill (f.)                                      | Kept: "competenza" reads as an HR term. "Una skill è un modo salvato di fare qualcosa."                                                                                                                                                                         |
| schedule / scheduled run               | pianificazione / esecuzione pianificata         | Direct.                                                                                                                                                                                                                                                         |
| sandbox                                | sandbox                                         | Kept; "ambiente isolato" where the English explains it in plain words ("in your browser" is "nel tuo browser").                                                                                                                                                 |
| deny list (hidden files)               | elenco dei file nascosti / elenco di esclusione | The English UI's own label is "Hide files"; the technical term is "elenco di esclusione".                                                                                                                                                                       |
| helper / sub-agent                     | agente di supporto / sotto-agente               | "Helper" in the plain UI, "sub-agent" on admin pages, as in English.                                                                                                                                                                                            |
| rules (privacy rules)                  | regole                                          | Direct.                                                                                                                                                                                                                                                         |
| Plan · Ask · Auto · Allow              | Pianifica · Chiedi · Auto · Consenti            | See the note below.                                                                                                                                                                                                                                             |
| settings / sign in / sign out          | impostazioni / accedi / esci                    | Standard.                                                                                                                                                                                                                                                       |
| administrator                          | amministratore                                  | Conventional generic form.                                                                                                                                                                                                                                      |
| delete / remove / archive / pin        | elimina / rimuovi / archivia / fissa            | "Elimina" destroys, "rimuovi" detaches, as in English "Delete" vs "Remove".                                                                                                                                                                                     |
| notifications                          | notifiche                                       | Direct.                                                                                                                                                                                                                                                         |
| Code (the area)                        | Code                                            | Area name, kept like the product names.                                                                                                                                                                                                                         |

## Plan / Ask / Auto / Allow: translated, with a tradeoff

The four permission levels are shown translated (Pianifica, Chiedi, Auto,
Consenti) because they are buttons users read in their own language all day, and
an untranslated English segmented control inside an Italian screen looks like a
missed string. The tradeoff: the docs (English only) and the agent's own
output say Plan, Ask, Auto, Allow, so an Italian user searching the docs or
reading a model's reply sees the English names. The docs section that
introduces the levels is the place to list both; this glossary is the mapping.
If the owner prefers the English names kept, the four values are in the keys under
`code.perm.*` (grep the catalogue for "Pianifica") and are a four-line change.

## Numbers, dates and units

Everything goes through `$lib/i18n/format`, so `it` gets "1.234,5",
"18 nov 2026, 14:05" and "2 ore fa" from `Intl` with no catalogue work.
Plural messages carry `one` and `other` (and `many`, equal to `other`, which
Italian uses for round millions).
