const assert = require('node:assert');
const { prStatus } = require('../gitinfo');

const pr = (o) => ({ state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: '', statusCheckRollup: [], ...o });
assert.strictEqual(prStatus(pr({ state: 'MERGED' })), 'Merged');
assert.strictEqual(prStatus(pr({ state: 'CLOSED' })), 'Closed');
assert.strictEqual(prStatus(pr({ isDraft: true })), 'Draft');
assert.strictEqual(prStatus(pr({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'FAILURE' }] })), 'Checks failing');
assert.strictEqual(prStatus(pr({ statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }] })), 'Checks running');
assert.strictEqual(prStatus(pr({ statusCheckRollup: [{ state: 'PENDING' }] })), 'Checks running');
assert.strictEqual(prStatus(pr({ mergeable: 'CONFLICTING' })), 'Conflicts');
assert.strictEqual(prStatus(pr({ reviewDecision: 'CHANGES_REQUESTED' })), 'Changes requested');
assert.strictEqual(prStatus(pr({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SKIPPED' }] })), 'Ready to merge');
console.log('gitinfo ok');
