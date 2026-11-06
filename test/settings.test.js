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
