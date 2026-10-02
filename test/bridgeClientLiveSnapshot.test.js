import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/eventBus.js';
import { BridgeClientEventRouter } from '../src/bridge/coordinator/bridgeClientEventRouter.js';

test('bridge routes passive TabObservation snapshots to the transient workflow event channel only', () => {
  const eventBus = new EventBus();
  const seen = [];
  eventBus.on('event', (event) => seen.push(event));
  const router = new BridgeClientEventRouter({
    pending: new Map(), commands: new Map(), artifacts: new Map(), eventBus,
    lifecycle: {}, publishObservedTurn() {}, registerObservedArtifacts: (items) => items,
    handleCommandResponse() {},
  });
  router.handleClientActivity('client-1', { session: { id: 'session-1' } }, {
    type: 'tab.observation',
    observation: {
      conversationId: 'session-1', revision: 4, observedAt: Date.now(),
      activeRequest: null,
      turn: { key: 'assistant-1', userKey: 'user-1', userPrompt: 'Update it', index: 1, promptBoundary: { submittedUserTurnKey: 'user-1', submittedUserTurnIndex: 0 } },
      generation: { state: 'running' }, blocker: { state: 'none' }, stableForMs: 0,
      output: { state: 'streaming', thinking: 'Inspecting', progress: 'Reading', answer: 'Working' },
      artifacts: [],
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'watch.turn.snapshot');
  assert.equal(seen[0].data.sourceClientId, 'client-1');
  assert.equal(seen[0].data.userTurnKey, 'user-1');
  assert.equal(seen[0].data.reasoning, 'Inspecting');
  assert.equal(eventBus.recentEvents(10).length, 0);
});

test('request-scoped observations project the real steer controls into canonical request progress', () => {
  const state = {
    requestId: 'request-1', clientId: 'client-1', callbacks: {},
    thinking: '', answer: '', progressText: '', progressItems: [], progressItemsSignature: '[]',
    reasoningHistory: [], responseBlocks: [], codeBlocks: [], codeBlockDiagnostics: [], artifacts: [],
    progress: { phase: 'generating' },
  };
  const progressUpdates = [];
  const lifecycle = {
    getState: () => ({
      submission: 'submitted', response: { epoch: 0, userTurnKey: 'user-1' },
      source: { conversationId: 'session-1' }, artifact: { required: false },
    }),
    updateProgress(target, payload, options) {
      target.progress = { ...target.progress, ...payload };
      progressUpdates.push({ payload, options });
    },
    emitRequestEvent() {},
    canonicalArtifactStatus: () => 'not_expected',
    ingestRequestTransition: () => ({ accepted: true }),
  };
  const router = new BridgeClientEventRouter({
    pending: new Map([[state.requestId, state]]), commands: new Map(), artifacts: new Map(), lifecycle,
    publishObservedTurn() {}, registerObservedArtifacts: (items) => items, handleCommandResponse() {},
  });

  router.handleClientActivity('client-1', { session: { id: 'session-1' } }, {
    type: 'tab.observation',
    observation: {
      conversationId: 'session-1', revision: 1, observedAt: Date.now(),
      activeRequest: { requestId: 'request-1', submittedUserTurnKey: 'user-1' },
      turn: { key: 'assistant-1', userKey: 'user-1', index: 1 },
      composer: { sendVisible: true },
      generation: { state: 'active', stopVisible: false, sendVisible: true },
      blocker: { state: 'none' },
      output: { state: 'streaming', answer: '', thinking: '', progress: '', progressItems: [] },
      artifact: { state: 'not_expected', count: 0 }, artifacts: [],
    },
  });

  assert.equal(state.progress.sendButtonVisible, true);
  assert.equal(state.progress.stopButtonVisible, false);
  assert.equal(progressUpdates.at(-1)?.options?.emit, false);
  assert.equal(progressUpdates.at(-1)?.payload?.meaningful, false);
});

test('a terminal orphan lease is released only when a later observation proves stable Voice idle', async () => {
  const releaseCalls = [];
  const router = new BridgeClientEventRouter({
    pending: new Map(), commands: new Map(), artifacts: new Map(), lifecycle: {},
    publishObservedTurn() {}, registerObservedArtifacts: (items) => items, handleCommandResponse() {},
    releaseStaleRequestLease: async (...args) => { releaseCalls.push(args); return { status: 'confirmed' }; },
  });
  const identity = {
    requestId: 'request-orphan', clientId: 'client-1', leaseId: 'lease-orphan',
    ownerServerInstanceId: 'server-old', responseEpoch: 3,
  };
  const client = {
    id: identity.clientId, ready: true, compatible: true,
    activeRequest: {
      requestId: identity.requestId, leaseId: identity.leaseId,
      ownerServerInstanceId: identity.ownerServerInstanceId, responseEpoch: identity.responseEpoch,
    },
  };
  router.handleClientActivity(identity.clientId, client, {
    type: 'tab.observation',
    observation: {
      observerId: 'observer-idle', revision: 3, observedAt: Date.now(), stableForMs: 900,
      activeRequest: client.activeRequest,
      document: { pageReady: true, chatMainReady: true },
      composer: { ready: true, primaryAction: 'voice', hasDraft: false },
      generation: { state: 'stopped' },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(releaseCalls.length, 1);
  assert.deepEqual(releaseCalls[0][0], identity);
  assert.equal(releaseCalls[0][1].id, identity.clientId);
  assert.equal(releaseCalls[0][1].tabObservation.observerId, 'observer-idle');
});
