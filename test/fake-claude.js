// Fake claude: reads stream-json user messages on stdin, answers in stream-json.
const readline = require('node:readline');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// One-shot commands used by the settings view.
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  console.log('9.9.9 (Claude Code)');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  if (process.env.FAKE_AUTH_FAIL) {
    console.error('auth broke');
    process.exit(1);
  }
  out({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'a@b.c', subscriptionType: 'max' });
  process.exit(0);
}

// "ask:<tool>" asks for permission first and echoes the answer it gets.
const finish = (text) => {
  out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  out({
    type: 'assistant',
    session_id: 'sess-1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'echo: ' + text }] },
  });
  out({ type: 'result', subtype: 'success', session_id: 'sess-1', total_cost_usd: 0.001 });
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_response') return finish('answer: ' + JSON.stringify(msg.response.response));
  const text = msg.message.content[0].text;
  if (!text.startsWith('ask:')) return finish(text);
  const tool = text.slice(4);
  const input = tool === 'AskUserQuestion'
    ? { questions: [{ question: 'Colour?', options: [{ label: 'red' }, { label: 'blue' }] }] }
    : { command: 'rm -rf /tmp/x' };
  out({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: tool, input } });
});
