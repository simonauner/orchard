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

// Permission requests: the agent waits, the answer goes back with claude's own input, unknown ids are refused.
function ask(id, tool, answer) {
  const x = new Agent({ id, cwd: process.cwd(), command: process.execPath, args: [path.join(__dirname, 'fake-claude.js')] });
  const statuses = [];
  x.on('status', (s) => statuses.push(s));
  return new Promise((resolve) => {
    x.on('event', (e) => {
      if (e.type === 'control_request') {
        assert.strictEqual(x.status, 'waiting');
        assert.strictEqual(x.respond('nope', answer), false);
        assert.strictEqual(x.respond('req-1', answer), true);
        assert.strictEqual(x.respond('req-1', answer), false); // answered once only
      }
      if (e.type === 'assistant') {
        const reply = JSON.parse(e.message.content[0].text.replace('echo: answer: ', ''));
        x.stop().then(() => resolve({ reply, statuses }));
      }
    });
    x.start();
    x.send('ask:' + tool);
  });
}
ask(8, 'Bash', { allow: true }).then(({ reply, statuses }) => {
  assert.deepStrictEqual(reply, { behavior: 'allow', updatedInput: { command: 'rm -rf /tmp/x' } });
  assert.deepStrictEqual(statuses.slice(0, 4), ['working', 'waiting', 'working', 'done']);
  return ask(9, 'Bash', { allow: false });
}).then(({ reply }) => {
  assert.strictEqual(reply.behavior, 'deny');
  return ask(10, 'AskUserQuestion', { allow: true, answers: { 'Colour?': 'blue', 'Injected?': 'x' } });
}).then(({ reply }) => {
  assert.deepStrictEqual(reply.updatedInput.answers, { 'Colour?': 'blue' });
  console.log('OK: permission requests and questions');
});

// Images go out as image blocks; anything but an allowed image type is refused.
const img = new Agent({ id: 7, cwd: process.cwd(), command: process.execPath, args: [path.join(__dirname, 'fake-claude.js')] });
img.start();
const written = [];
img.proc.stdin.write = (line) => written.push(JSON.parse(line));
assert.throws(() => img.send('x', [{ media_type: 'text/html', data: 'AA==' }]), /Unsupported image/);
assert.strictEqual(img.send('look', [{ media_type: 'image/png', data: 'AA==' }]), true);
assert.deepStrictEqual(written[0].message.content.map((b) => b.type), ['text', 'image']);
img.stop().then(() => console.log('OK: image blocks'));
