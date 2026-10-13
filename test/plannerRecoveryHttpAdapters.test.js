import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserBridge } from '../src/browserBridge.js';
import { isCommandResponsePayload } from '../src/bridge/coordinator/bridgeClientEventRouter.js';
import { emitPromptSubmitted, emitTabObservation } from './support/bridgeObservation.js';

function tabObservation(revision, observedAt) {
  return {
    observerId: 'observer-private',
    revision,
    observedAt,
    stableForMs: 1_200,
    document: { pageReady: true, chatMainReady: true },
    composer: { ready: true, primaryAction: 'voice', hasDraft: false },
    generation: { state: 'stopped', streamingVisible: false, stopVisible: false },
    blocker: { state: 'none' },
    turn: { key: 'private-turn-key', userKey: 'private-user-key', phase: 'final', userPrompt: 'private prompt' },
    output: { answer: 'private assistant output', thinking: 'private reasoning' },
    activeRequest: null,
  };
}

class RecoveryHub extends EventEmitter {
  constructor() {
    super();
    const observedAt = Date.now();
    this.clientList = ['client-primary', 'client-explicit'].map((id) => ({
      id,
      ready: true,
      compatible: true,
      compatibility: { compatible: true },
      runtime: 'extension',
      transport: 'extension',
      url: 'https://chatgpt.com/c/private-session',
      tabObservation: tabObservation(4, observedAt),
    }));
    this.activeClient = this.clientList[0];
    this.selectedClientId = this.activeClient.id;
    this.sent = [];
    this.refreshMode = 'advance';
    this.cancelMode = 'success';
  }

  get clients() { return this.clientList; }
  get needsSelection() { return false; }
  get debugEvents() { return []; }

  sendToActiveWithDelivery(payload, options) {
    return this.sendToClientWithDelivery(this.activeClient.id, payload, options);
  }

  sendToClientWithDelivery(clientId, payload, options = {}) {
    const client = this.clientList.find((candidate) => candidate.id === clientId);
    if (!client) throw Object.assign(new Error('exact client missing'), { code: 'BROWSER_CLIENT_NOT_FOUND' });
    this.sent.push({ clientId, payload, request: options.request || null });
    if (payload.type === 'tab.observation.refresh') {
      let observation = client.tabObservation;
      if (this.refreshMode === 'advance') {
        observation = tabObservation(observation.revision + 1, Date.now());
        client.tabObservation = observation;
        setImmediate(() => this.emit('client.activity', {
          clientId,
          client,
          payload: { type: 'tab.observation', observation },
        }));
      }
      setImmediate(() => this.emit('client.message', {
        clientId,
        payload: {
          type: 'tab.observation.refreshed',
          commandId: payload.commandId,
          revision: observation.revision,
          observedAt: observation.observedAt,
        },
      }));
    }
    if (payload.type === 'prompt.cancel') {
      const succeeded = this.cancelMode === 'success';
      setImmediate(() => this.emit('client.message', {
        clientId,
        payload: {
          type: succeeded ? 'request.effect.succeeded' : 'request.effect.uncertain',
          commandId: payload.commandId,
          requestId: payload.requestId,
          sourceClientId: clientId,
          effectId: payload.effect.effectId,
          effectType: 'prompt.cancel',
          code: succeeded ? '' : 'BROWSER_EFFECT_UNCERTAIN',
          message: succeeded ? '' : 'private extension error detail',
          result: succeeded ? { cancelled: true } : undefined,
        },
      }));
    }
    return { client, delivered: Promise.resolve({ clientId, deliveredAt: Date.now() }) };
  }
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test('refresh result payload is correlated by the command registry', () => {
  assert.equal(isCommandResponsePayload({ type: 'tab.observation.refreshed', commandId: 'refresh-1' }), true);
  assert.equal(isCommandResponsePayload({ type: 'tab.observation.refreshed' }), false);
});

test('observation refresh routes only to the explicit client and returns its newer observation', async () => {
  const hub = new RecoveryHub();
  hub.clientList[1].tabObservation = tabObservation(4, Date.now() - 60_000);
  const bridge = new BrowserBridge(hub);
  const priorPrimaryRevision = hub.activeClient.tabObservation.revision;
  const priorTargetRevision = hub.clientList[1].tabObservation.revision;
  try {
    const result = await bridge.refreshTabObservation('client-explicit');
    assert.equal(hub.sent.length, 1);
    assert.equal(hub.sent[0].clientId, 'client-explicit');
    assert.equal(hub.sent[0].payload.type, 'tab.observation.refresh');
    assert.equal(result.sourceClientId, 'client-explicit');
    assert.ok(result.observation.revision > priorTargetRevision);
    assert.ok(result.observation.observedAt > Date.now() - 5_000);
    assert.equal(hub.activeClient.tabObservation.revision, priorPrimaryRevision);
  } finally {
    await bridge.close();
  }
});

test('observation refresh fails closed for missing, unknown, and unchanged observations', async () => {
  const hub = new RecoveryHub();
  hub.clientList[1].tabObservation = tabObservation(4, Date.now() - 60_000);
  const bridge = new BrowserBridge(hub);
  try {
    await assert.rejects(bridge.refreshTabObservation(''), (error) => error.code === 'TAB_OBSERVATION_SOURCE_REQUIRED');
    await assert.rejects(bridge.refreshTabObservation('unknown-client'), (error) => error.code === 'TAB_OBSERVATION_CLIENT_NOT_FOUND');
    hub.refreshMode = 'unchanged';
    await assert.rejects(bridge.refreshTabObservation('client-explicit'), (error) => error.code === 'TAB_OBSERVATION_REFRESH_NOT_FRESH');
  } finally {
    await bridge.close();
  }
});

async function startTrackedRequest(bridge, hub) {
  const responsePromise = bridge.sendRequest({ message: 'private request prompt' });
  void responsePromise.catch(() => {});
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send')?.payload;
  assert.ok(prompt, 'test request must be bound to an exact source client');
  emitPromptSubmitted(hub, { requestId: prompt.requestId, clientId: 'client-primary' });
  emitTabObservation(hub, {
    requestId: prompt.requestId,
    clientId: 'client-primary',
    generation: 'active',
    outputState: 'streaming',
  });
  return { prompt, responsePromise };
}

test('request cancellation uses canonical request identity and confirmed typed prompt.cancel only', async () => {
  const hub = new RecoveryHub();
  const bridge = new BrowserBridge(hub);
  let globalCancelCalls = 0;
  bridge.cancelActive = () => { globalCancelCalls += 1; return 1; };
  try {
    const { prompt, responsePromise } = await startTrackedRequest(bridge, hub);
    const result = await bridge.cancelTrackedRequest(prompt.requestId, { sourceClientId: 'client-primary' });
    const cancel = hub.sent.find((entry) => entry.payload.type === 'prompt.cancel');
    assert.ok(cancel);
    assert.equal(cancel.clientId, 'client-primary');
    assert.equal(cancel.payload.requestId, prompt.requestId);
    assert.equal(cancel.request.requestId, prompt.requestId);
    assert.ok(cancel.request.leaseId);
    assert.ok(cancel.request.ownerServerInstanceId);
    assert.equal(cancel.request.responseEpoch, 0);
    assert.equal(cancel.payload.effect.kind, 'prompt.cancel');
    assert.equal(cancel.payload.effect.idempotencyKey, `${prompt.requestId}:prompt.cancel:responseEpoch:0`);
    assert.equal(cancel.payload.effect.effectId, `${prompt.requestId}:prompt.cancel:responseEpoch:0:attempt:1`);
    assert.equal(cancel.payload.effect.preconditions.requestId, prompt.requestId);
    assert.equal(cancel.payload.effect.preconditions.responseEpoch, 0);
    assert.equal(result.cancelled, true);
    assert.equal(globalCancelCalls, 0);
    assert.equal(hub.sent.some((entry) => entry.payload.type === 'browser.stop'), false);
    await assert.rejects(responsePromise);
  } finally {
    await bridge.close();
  }
});

test('request cancellation rejects missing, unknown, terminal, and mismatched identities', async () => {
  const hub = new RecoveryHub();
  const bridge = new BrowserBridge(hub);
  try {
    await assert.rejects(bridge.cancelTrackedRequest('', { sourceClientId: 'client-primary' }), (error) => error.code === 'REQUEST_ID_REQUIRED');
    await assert.rejects(bridge.cancelTrackedRequest('unknown-request', { sourceClientId: 'client-primary' }), (error) => error.code === 'REQUEST_NOT_FOUND');
    const { prompt, responsePromise } = await startTrackedRequest(bridge, hub);
    await assert.rejects(bridge.cancelTrackedRequest(prompt.requestId, {}), (error) => error.code === 'SOURCE_CLIENT_ID_REQUIRED');
    await assert.rejects(bridge.cancelTrackedRequest(prompt.requestId, { sourceClientId: 'client-explicit' }), (error) => error.code === 'REQUEST_SOURCE_MISMATCH');
    assert.equal(hub.sent.some((entry) => entry.payload.type === 'prompt.cancel'), false);
    await bridge.cancelTrackedRequest(prompt.requestId, { sourceClientId: 'client-primary' });
    await assert.rejects(bridge.cancelTrackedRequest(prompt.requestId, { sourceClientId: 'client-primary' }), (error) => error.code === 'REQUEST_TERMINAL');
    await assert.rejects(responsePromise);
  } finally {
    await bridge.close();
  }
});

test('ambiguous prompt.cancel outcome is never returned as successful cancellation', async () => {
  const hub = new RecoveryHub();
  hub.cancelMode = 'uncertain';
  const bridge = new BrowserBridge(hub);
  try {
    const { prompt, responsePromise } = await startTrackedRequest(bridge, hub);
    void responsePromise.catch(() => {});
    await assert.rejects(bridge.cancelTrackedRequest(prompt.requestId, { sourceClientId: 'client-primary' }),
      (error) => error.code === 'REQUEST_CANCEL_UNCONFIRMED');
  } finally {
    await bridge.close();
  }
});
