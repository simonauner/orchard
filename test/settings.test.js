// Tests claudeStatus and checkExecutable without a real claude.
const assert = require('node:assert');
const path = require('node:path');
const { claudeStatus, checkExecutable } = require('../agent');

const fake = [process.execPath, [path.join(__dirname, 'fake-claude.js')]];

(async () => {
  const st = await claudeStatus(...fake);
  assert.deepStrictEqual(st, {
    ok: true, version: '9.9.9', loggedIn: true, authMethod: 'claude.ai',
    apiProvider: 'firstParty', email: 'a@b.c', subscriptionType: 'max',
  });

  const missing = await claudeStatus('/no/such/claude');
  assert.strictEqual(missing.ok, false);
  assert.match(missing.error, /not found/);

  process.env.FAKE_AUTH_FAIL = '1';
  const failed = await claudeStatus(...fake);
  delete process.env.FAKE_AUTH_FAIL;
  assert.deepStrictEqual(failed, { ok: false, error: 'auth broke' });

  assert.doesNotThrow(() => checkExecutable(process.execPath));
  assert.throws(() => checkExecutable('claude'), /absolute/);
  assert.throws(() => checkExecutable(__dirname), /Not an executable/); // directories are "executable" too
  assert.throws(() => checkExecutable(path.join(__dirname, 'nope')), /Not an executable/);
  console.log('OK: claudeStatus, checkExecutable');
})().catch((e) => { console.error(e); process.exit(1); });

// claudeDefaults: env beats settings, local > project > user.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const { claudeDefaults } = require('../agent');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchard-defaults-'));
  const write = (rel, obj) => {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, rel), typeof obj === 'string' ? obj : JSON.stringify(obj));
  };
  const env = { CLAUDE_CONFIG_DIR: path.join(tmp, 'home') };
  const repo = path.join(tmp, 'repo');
  assert.deepStrictEqual(claudeDefaults(repo, env), { model: null, effort: null });
  write('home/settings.json', { model: 'opus', effortLevel: 'high' });
  write('repo/.claude/settings.json', { effortLevel: 'low' });
  write('repo/.claude/settings.local.json', '{ broken');
  assert.deepStrictEqual(claudeDefaults(repo, env), { model: 'opus', effort: 'low' });
  write('repo/.claude/settings.local.json', { model: 'sonnet' });
  assert.deepStrictEqual(claudeDefaults(repo, env), { model: 'sonnet', effort: 'low' });
  assert.deepStrictEqual(claudeDefaults(repo, { ...env, ANTHROPIC_MODEL: 'haiku', CLAUDE_CODE_EFFORT_LEVEL: 'max' }), { model: 'haiku', effort: 'max' });
  fs.rmSync(tmp, { recursive: true });
  console.log('OK: claudeDefaults');
}
