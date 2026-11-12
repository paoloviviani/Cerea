// OpenAI-compatible chat client with per-call usage accounting. Key comes from env only; never logged.
import fs from 'node:fs';
const BASE = process.env.LLM_BASE || 'https://api.cortecs.ai/v1';
const KEY = process.env.CORTECS_KEY || fs.readFileSync(process.env.CORTECS_KEY_FILE || '/home/ubuntu/.config/cerea-secrets/cortecs.key', 'utf8').trim();

export class Meter {
  constructor() { this.calls = []; }
  add(u, ms) { this.calls.push({ p: u?.prompt_tokens ?? u?.inputTokens ?? 0, c: u?.completion_tokens ?? u?.outputTokens ?? 0, ms }); }
  get prompt() { return this.calls.reduce((a, x) => a + x.p, 0); }
  get completion() { return this.calls.reduce((a, x) => a + x.c, 0); }
}

export async function chat(model, body, meter, retries = 2) {
  for (let i = 0; ; i++) {
    const t = Date.now();
    const r = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify({ model, temperature: 0, ...body }) });
    const txt = await r.text();
    if (!r.ok) { if (i < retries && (r.status >= 500 || r.status === 429)) { await new Promise((s) => setTimeout(s, 1500)); continue; } throw new Error(`LLM ${r.status}: ${txt.slice(0, 300)}`); }
    const j = JSON.parse(txt);
    meter?.add(j.usage, Date.now() - t);
    return j;
  }
}
