import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

async function createReleaseHandler({ activeRequest = { requestId: 'request-1' } } = {}) {
  const context = vm.createContext({});
  context.globalThis = context;
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestReleaseCommand.js'), 'utf8');
  vm.runInContext(source, context);
  const releaseCalls = [];
  const settlements = [];
  const handler = context.ChatGptRequestReleaseCommand.createRequestReleaseCommand({
    diagnostic: () => {},
    getActiveRequest: () => activeRequest,
    releaseRequest: (...args) => { releaseCalls.push(args); return true; },
    settleReleaseCleanup: async (value) => { settlements.push(value); },
  });
  return { handler, releaseCalls, settlements };
}

const staleRelease = {
  requestId: 'request-1',
  commandId: 'command-1',
  leaseId: 'lease-1',
  ownerServerInstanceId: 'server-1',
  recoveryMode: 'stale_lease',
};

test('stale release clears only the matching Bridge request lease without clicking Stop', async () => {
  const state = await createReleaseHandler();
  await state.handler.handleRequestRelease(staleRelease);

  assert.deepEqual(state.releaseCalls, [[{ requestId: 'request-1' }, 'server_terminal']]);
  assert.equal(state.settlements[0]?.status, 'completed');
});

test('stale release refuses a mismatched content request without changing its state', async () => {
  const state = await createReleaseHandler({ activeRequest: { requestId: 'request-other' } });
  await state.handler.handleRequestRelease(staleRelease);

  assert.equal(state.releaseCalls.length, 0);
  assert.equal(state.settlements[0]?.code, 'RELEASE_ACTIVE_REQUEST_MISMATCH');
});
