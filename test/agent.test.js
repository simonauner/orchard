// Tests Agent against a fake "claude" that speaks the stream-json protocol.
const assert = require('node:assert');
const path = require('node:path');
const { Agent } = require('../agent');

const agent = new Agent({
  id: 1,
  cwd: process.cwd(),
  command: process.execPath,
  args: [path.join(__dirname, 'fake-claude.js')],
});

const events = [];
const statuses = [];
agent.on('event', (e) => events.push(e));
agent.on('status', (s) => statuses.push(s));

agent.start();
assert.strictEqual(agent.send('hello'), true);

const timer = setTimeout(() => {
  console.error('timeout', { events, statuses });
  process.exit(1);
}, 5000);

agent.on('status', (s) => {
  if (s !== 'done') return;
  clearTimeout(timer);
  const text = events
    .filter((e) => e.type === 'assistant')
    .flatMap((e) => e.message.content)
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  assert.strictEqual(text, 'echo: hello');
  assert.strictEqual(agent.sessionId, 'sess-1');
  assert.deepStrictEqual(statuses, ['working', 'done']);

  agent.on('status', (s2) => {
    if (s2 !== 'stopped') return;
    assert.strictEqual(agent.send('again'), false);
    console.log('OK: spawn, send, stream, result, stop');
  });
  agent.stop();
});

// stop() resolves once the process has exited, and is safe to call again.
const b = new Agent({ id: 2, cwd: process.cwd(), command: process.execPath, args: [path.join(__dirname, 'fake-claude.js')] });
b.start();
b.stop().then(() => {
  assert.notStrictEqual(b.proc.exitCode ?? b.proc.signalCode, null);
  return b.stop();
}).then(() => console.log('OK: stop resolves on exit'));

// Model and effort are allowlisted because they become CLI arguments.
const withOpts = new Agent({ id: 3, cwd: '.', model: 'opus', effort: 'high' });
assert.deepStrictEqual(withOpts.args.slice(-4), ['--model', 'opus', '--effort', 'high']);
assert.ok(!new Agent({ id: 4, cwd: '.' }).args.includes('--model'));
assert.throws(() => new Agent({ id: 5, cwd: '.', model: '--dangerously-skip-permissions' }), /Unknown model/);
assert.throws(() => new Agent({ id: 6, cwd: '.', effort: 'ultra' }), /Unknown effort/);
console.log('OK: model/effort allowlist');

// A restarted agent resumes its session; the id comes from disk, so it must not pass as a flag.
const r = new Agent({ id: 7, cwd: process.cwd(), command: process.execPath, args: [path.join(__dirname, 'fake-claude.js')] });
r.sessionId = 'sess-1';
r.start();
assert.deepStrictEqual(r.proc.spawnargs.slice(-2), ['--resume', 'sess-1']);
assert.strictEqual(r.running, true);
r.stop().then(() => {
  assert.strictEqual(r.running, false);
  r.sessionId = '--dangerously-skip-permissions';
  assert.throws(() => r.start(), /Invalid session id/);
  console.log('OK: resume');
});
