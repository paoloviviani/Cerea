// LLM-free verification of the architectural questions (interception, ref stability, diff, CDP, Stagehand observe-without-execute).
import { startFixtures } from './src/fixtures.mjs';
import { chromium } from 'playwright';
import { CHROMIUM, snapDiff } from './src/engine-pw.mjs';
import { classify, elementMeta } from './src/classify.mjs';
import { localBrowser, Stagehand } from '@browserbasehq/stagehand';
const { srv, base } = await startFixtures();
const hr = (s) => console.log('\n=== ' + s);

hr('PW: ref stability + diff + classify/hold (scripted actions, no LLM)');
const b = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
const p = await b.newPage(); await p.goto(base + '/form');
const s1 = await p.ariaSnapshot({ mode: 'ai' });
const name = p.getByRef('e5'), save = p.getByRef('e14');
const gate = async (action, ref) => { const meta = ref ? await elementMeta(p.getByRef(ref)) : null; const cls = classify(action, meta, p.url()); const allow = cls !== 'commit'; console.log(`  ${JSON.stringify(action)} -> ${cls} -> ${allow ? 'RUN' : 'HELD (needs approval)'}`); return allow; };
if (await gate({ kind: 'fill', ref: 'e5', text: 'Ada' }, 'e5')) await name.fill('Ada');
const s2 = await p.ariaSnapshot({ mode: 'ai' });
console.log('refs of unchanged elements identical across snapshots:', s1.split('\n').filter((l) => l.includes('[ref=')).every((l) => s2.includes(l.replace(/ \[active\]/, '')) || /e5\]/.test(l)));
console.log('diff after fill:', JSON.stringify(snapDiff(s1, s2)));
await gate({ kind: 'click', ref: 'e14' }, 'e14'); // submit -> commit, held
await gate({ kind: 'navigate', url: 'https://example.invalid/x' });
await gate({ kind: 'navigate', url: '/list' });
await p.goto(base + '/list'); const l1 = await p.ariaSnapshot({ mode: 'ai' }); await p.goto(base + '/list?page=2'); const l2 = await p.ariaSnapshot({ mode: 'ai' });
const ids = (s) => new Set((s.match(/\[ref=[^\]]+\]/g) || []));
console.log('refs shared across a navigation to page 2 (same-shaped page):', [...ids(l1)].filter((x) => ids(l2).has(x)).length, 'of', ids(l1).size, '(refs are per-snapshot ids, reassigned after navigation)');
const big = await (async () => { await p.goto(base + '/table'); return p.ariaSnapshot({ mode: 'ai' }); })();
console.log('200-row table snapshot: chars', big.length, '~tokens', Math.round(big.length / 3.5));

hr('PW: CDP access (screencast + input injection)');
const cdp = await p.context().newCDPSession(p); let frames = 0;
cdp.on('Page.screencastFrame', async (f) => { frames++; await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); });
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 50, maxWidth: 640 });
await p.goto(base + '/form'); await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 40, button: 'left', clickCount: 1 }); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 100, y: 40, button: 'left', clickCount: 1 });
await new Promise((r) => setTimeout(r, 800)); await cdp.send('Page.stopScreencast');
console.log('screencast frames received:', frames, '; Input.dispatchMouseEvent ok');
await p.goto(base + '/form'); const t1 = await p.ariaSnapshot({ mode: 'ai' });
await p.evaluate(() => { const h = document.createElement('p'); h.innerHTML = '<a href="/list">inserted link</a>'; document.body.prepend(h); });
const t2 = await p.ariaSnapshot({ mode: 'ai' });
console.log('after inserting a node at top: Save button ref before/after:', (t1.match(/button "Save" \[ref=(\w+)\]/) || [])[1], (t2.match(/button "Save" \[ref=(\w+)\]/) || [])[1], '| new link ref:', (t2.match(/inserted link" \[ref=(\w+)\]/) || [])[1]);
await b.close();

hr('Stagehand: observe() returns concrete actions WITHOUT executing (mock LLM), then we gate + execute ourselves');
let schemaSeen = null;
const browser = await localBrowser.launch({ executablePath: CHROMIUM, headless: true, chromiumSandbox: false });
const sh = await Stagehand.create({ browser, logging: { level: 'off', format: 'json' }, model: { generate: async (pr) => {
  schemaSeen = JSON.stringify(pr.responseFormat?.schema || null).slice(0, 400);
  if (pr.responseFormat?.type === 'json_schema') return { role: 'assistant', outputFormat: 'json_schema', content: [{ type: 'text', text: '{}' }], structuredContent: { elements: [{ elementId: '0-5', description: 'Email field', method: 'fill', arguments: ['ada@example.test'] }] }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  throw new Error('unexpected non-structured call');
} } });
const [sp] = await browser.context.pages(); await sp.goto(base + '/form');
const obs = await sh.observe('fill the email field');
console.log('observe result:', JSON.stringify(obs.data));
const act0 = obs.data[0];
const loc = sp.locator(act0.selector);
console.log('Stagehand Locator methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(loc)).filter((m) => m !== 'constructor').join(','));
const evalFn = loc.evaluate ? 'evaluate' : null;
console.log('executing the observed action ourselves via locator.fill (after gate):'); await loc.fill(act0.arguments[0]); console.log('  value now:', await sp.evaluate(() => document.querySelector('input[name=email]').value));
const snap = await sp.snapshot(); console.log('page.snapshot() keys:', Object.keys(snap), JSON.stringify(snap).length, 'chars');
console.log('Stagehand browser handle keys:', Object.keys(browser).join(','), '| cdpUrl:', typeof browser.cdpUrl === 'string' ? browser.cdpUrl : typeof browser.cdpUrl);
await sh.close(); await browser.close(); srv.close();
