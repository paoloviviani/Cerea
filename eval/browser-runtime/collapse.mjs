// Estimate savings of row collapsing on the 200-row table AI snapshot (keeps first KEEP rows, collapses the rest).
import { startFixtures } from './src/fixtures.mjs';
import { chromium } from 'playwright';
import { CHROMIUM } from './src/engine-pw.mjs';
export function collapseRows(snap, keep = 3) {
  const lines = snap.split('\n'); const out = []; let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^(\s*)- row /);
    if (!m) { out.push(lines[i++]); continue; }
    const ind = m[1].length; const blocks = [];
    while (i < lines.length && (lines[i].match(/^(\s*)- row /)?.[1].length === ind)) { const s = i++; while (i < lines.length && (lines[i].length - lines[i].trimStart().length) > ind) i++; blocks.push(lines.slice(s, i)); }
    blocks.slice(0, keep).forEach((b) => out.push(...b));
    if (blocks.length > keep) out.push(`${' '.repeat(ind)}- text: "... and ${blocks.length - keep} more rows like this; use extract"`);
  }
  return out.join('\n');
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const { srv, base } = await startFixtures(); const b = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  const p = await b.newPage(); await p.goto(base + '/table'); const s = await p.ariaSnapshot({ mode: 'ai' }); const c = collapseRows(s);
  console.log(JSON.stringify({ fullChars: s.length, collapsedChars: c.length, fullTok: Math.round(s.length / 3.5), collapsedTok: Math.round(c.length / 3.5) })); console.log(c.split('\n').slice(0, 12).join('\n'));
  await b.close(); srv.close();
}
