// Usage: node run.mjs <engine:pw|sh|both> <model[,model]> [task,task] [--diff] [--shot] [--hold]
import fs from 'node:fs';
import { startFixtures, resetState } from './src/fixtures.mjs';
import { TASKS } from './src/tasks.mjs';
import { runPw } from './src/engine-pw.mjs';
import { runSh } from './src/engine-sh.mjs';
const [engine, models, taskIds] = process.argv.slice(2);
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const { srv, base } = await startFixtures();
fs.mkdirSync('results', { recursive: true });
for (const model of models.split(',')) for (const task of TASKS.filter((t) => !taskIds || taskIds.startsWith('--') || taskIds.split(',').includes(t.id)))
  for (const eng of engine === 'both' ? ['pw', 'sh'] : [engine]) {
    resetState();
    const opts = { model, base, task, useDiff: flags.includes('--diff'), shot: flags.includes('--shot'), vision: flags.includes('--shot') };
    let r;
    try { r = await (eng === 'pw' ? runPw(opts) : runSh(opts)); } catch (e) { r = { engine: eng, model, task: task.id, error: String(e.message).slice(0, 300), failures: ['crash'] }; }
    r.success = !!task.check(r.answer, r); r.flags = flags;
    r.hits = (await import('./src/fixtures.mjs')).state.hits.slice();
    fs.appendFileSync('results/runs.jsonl', JSON.stringify(r) + '\n');
    console.log(`${r.engine}\t${model}\t${task.id}\t${r.success ? 'PASS' : 'FAIL'}\tsteps=${r.steps}\tp=${r.prompt}\tc=${r.completion}\t${r.ms}ms\t${(r.failures || []).slice(0, 3).join(' | ')}`);
  }
srv.close(); process.exit(0);
