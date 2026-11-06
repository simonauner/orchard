// Fake claude: reads stream-json user messages on stdin, answers in stream-json.
const readline = require('node:readline');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  const text = msg.message.content[0].text;
  out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  out({
    type: 'assistant',
    session_id: 'sess-1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'echo: ' + text }] },
  });
  out({ type: 'result', subtype: 'success', session_id: 'sess-1', total_cost_usd: 0.001 });
});
