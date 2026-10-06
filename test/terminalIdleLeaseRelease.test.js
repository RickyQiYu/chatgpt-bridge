import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleTerminalIdleLeaseRelease } from '../src/bridge/coordinator/terminalIdleLeaseRelease.js';
import { RequestResultMaterializer } from '../src/bridge/coordinator/requestResultMaterializer.js';

const requestId = 'turn-terminal-idle-release';
const activeRequest = {
  requestId,
  leaseId: 'lease-terminal-idle-release',
  ownerServerInstanceId: 'server-terminal-idle-release',
  responseEpoch: 0,
};

function terminalIdleObservation() {
  return {
    activeRequest: { ...activeRequest },
    generation: { state: 'stopped' },
    composer: { ready: true, primaryAction: 'voice', hasDraft: false },
    stableForMs: 1_000,
  };
}

function schedule(pending, releaseStaleRequestLease) {
  const observation = terminalIdleObservation();
  scheduleTerminalIdleLeaseRelease({
    pending,
    releaseStaleRequestLease,
    clientId: 'client-terminal-idle-release',
    client: { id: 'client-terminal-idle-release', activeRequest: observation.activeRequest },
    observation,
  });
}

test('releases an idle terminal lease after its pending request finishes', async () => {
  const pending = new Map();
  const releases = [];
  const releaseStaleRequestLease = async (...args) => {
    releases.push(args);
    return { status: 'confirmed' };
  };
  const owner = {
    pending,
    runtime: { clear() {} },
    emitRequestEvent() {},
    onRequestFinished(state) {
      assert.equal(pending.has(state.requestId), false);
      schedule(pending, releaseStaleRequestLease);
    },
  };
  const materializer = new RequestResultMaterializer(owner);
  const state = {
    requestId,
    runtime: { finished: false },
    answer: '',
    thinking: '',
    progressText: '',
    events: [],
    followers: new Set(),
    callbacks: {},
    resolve() {},
    reject() {},
  };
  pending.set(requestId, state);

  schedule(pending, releaseStaleRequestLease);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 0);

  materializer.finish(state, null, 'final response');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(releases.length, 1);
  assert.equal(releases[0][0].requestId, requestId);
});

test('does not release an idle-looking lease while its request is still pending', async () => {
  const pending = new Map([[requestId, { requestId }]]);
  const releases = [];
  schedule(pending, async (...args) => { releases.push(args); return { status: 'confirmed' }; });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(releases.length, 0);
});
