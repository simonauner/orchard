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
assert.strictEqual(agent.send('hej'), true);

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
  assert.strictEqual(text, 'echo: hej');
  assert.strictEqual(agent.sessionId, 'sess-1');
  assert.deepStrictEqual(statuses, ['working', 'done']);

  agent.on('status', (s2) => {
    if (s2 !== 'stopped') return;
    assert.strictEqual(agent.send('igen'), false);
    console.log('OK: spawn, send, stream, result, stop');
  });
  agent.stop();
});
