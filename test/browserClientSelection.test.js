import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserBridge } from '../src/browserBridge.js';
import { BrowserClientCoordinator } from '../src/bridge/coordinator/browserClientCoordinator.js';
import { commandResult, emitPromptSubmitted, emitTabObservation } from './support/bridgeObservation.js';

class ClientSelectionHub extends EventEmitter {
  constructor(clients = [], options = {}) {
    super();
    this.sent = [];
    this.autoRelease = options.autoRelease !== false;
    this.reloadControlCalls = [];
    this._clients = clients;
    this._selectedClientId = clients.find((client) => client.selected)?.id || '';
  }
  get clients() { return this._clients; }
  get selectedClientId() { return this._selectedClientId; }
  get debugEvents() { return []; }
  get needsSelection() { return !this._selectedClientId && this._clients.filter((client) => client.ready !== false).length > 1; }
  get activeClient() {
    if (this._selectedClientId) return this._clients.find((client) => client.id === this._selectedClientId && client.ready !== false) || null;
    const ready = this._clients.filter((client) => client.ready !== false);
    return ready.length === 1 ? ready[0] : null;
  }
  sendToClientWithDelivery(clientId, payload) {
    const client = this.sendToClient(clientId, payload);
    if (payload.type === 'prompt.cancel') {
      setImmediate(() => {
        const effect = payload.effect || {};
        this.emit('client.message', { clientId, payload: {
          type: 'request.effect.started', requestId: payload.requestId,
          effectId: effect.effectId, effectType: 'prompt.cancel', effectDomain: 'browser',
          idempotencyKey: effect.idempotencyKey, retryPolicy: effect.retryPolicy,
          preconditions: effect.preconditions, preconditionsHash: effect.preconditionsHash,
          attempt: effect.attempt, responseEpoch: effect.responseEpoch,
        } });
        this.emit('client.message', { clientId, payload: {
          type: 'request.effect.succeeded', commandId: payload.commandId, requestId: payload.requestId,
          effectId: effect.effectId, effectType: 'prompt.cancel', effectDomain: 'browser',
          idempotencyKey: effect.idempotencyKey, retryPolicy: effect.retryPolicy,
          preconditions: effect.preconditions, preconditionsHash: effect.preconditionsHash,
          attempt: effect.attempt, responseEpoch: effect.responseEpoch, message: payload.reason,
        } });
      });
    }
    if (payload.type === 'request.release' && this.autoRelease) {
      setImmediate(() => this.emit('client.message', {
        clientId,
        payload: { type: 'lease.released', commandId: payload.commandId,
          requestId: payload.requestId,
          released: true,
          activeRequest: null,
        },
      }));
    }
    return { client, delivered: Promise.resolve({ clientId, deliveredAt: Date.now() }) };
  }
  sendToClient(clientId, payload) {
    this.sent.push({ clientId, payload });
    return this._clients.find((item) => item.id === clientId) || { id: clientId, ready: true };
  }
  sendReloadControlToClient(clientId, payload) {
    this.reloadControlCalls.push({ clientId, payload });
    return this.sendToClient(clientId, payload);
  }
  selectClient(clientId) { this._selectedClientId = clientId; return this._clients.find((item) => item.id === clientId); }
  clearSelectedClient() { this._selectedClientId = ''; }
}

function nextTick() { return new Promise((resolve) => setImmediate(resolve)); }

test('extension prompt admission requires a fresh stable Voice composer, not Send, Stop, or unknown', () => {
  const client = {
    id: 'client-composer-readiness', runtime: 'extension', ready: true, compatible: true, activeRequest: null,
    tabObservation: {
      observerId: 'observer-ready', revision: 3, observedAt: Date.now(), stableForMs: 900,
      document: { pageReady: true, chatMainReady: true },
      composer: { ready: true, primaryAction: 'voice', hasDraft: false },
      generation: { state: 'stopped' },
    },
  };
  const hub = new ClientSelectionHub([client]);
  const coordinator = new BrowserClientCoordinator({
    hub, pending: new Map(), lifecycle: {}, runtimeOptions: {}, sendCommand: async () => ({}),
  });

  assert.equal(coordinator.isPromptClientIdle(client), true);
  for (const primaryAction of ['send', 'stop', 'unknown']) {
    assert.equal(coordinator.isPromptClientIdle({
      ...client,
      tabObservation: {
        ...client.tabObservation,
        composer: { ready: true, primaryAction },
      },
    }), false, primaryAction);
  }
  assert.equal(coordinator.isPromptClientIdle({
    ...client,
    tabObservation: {
      ...client.tabObservation,
      composer: { ready: true, primaryAction: 'voice', hasDraft: true },
    },
  }), false, 'Voice control with composer text');
  assert.equal(coordinator.isPromptClientIdle({
    ...client,
    tabObservation: { ...client.tabObservation, observedAt: Date.now() - 31_000 },
  }), false, 'stale observation');

  const browserClient = { ...client, id: 'browser-websocket-client', runtime: 'browser' };
  assert.equal(coordinator.isPromptClientIdle(browserClient), true);
  assert.equal(coordinator.isPromptClientIdle({
    ...browserClient,
    tabObservation: {
      ...browserClient.tabObservation,
      composer: { ready: true, primaryAction: 'send', hasDraft: true },
    },
  }), false, 'browser websocket clients also need Voice-idle composer proof');
});

test('stale Voice-idle extension observation refreshes before prompt admission', async () => {
  const staleObservedAt = Date.now() - 60_000;
  const client = {
    id: 'client-stale-observation',
    runtime: 'extension',
    ready: true,
    compatible: true,
    session: { id: 'session-stale-observation' },
    activeRequest: null,
    tabObservation: {
      observerId: 'observer-stale',
      revision: 3,
      observedAt: staleObservedAt,
      stableForMs: 5_000,
      document: { pageReady: true, chatMainReady: true },
      composer: { ready: true, primaryAction: 'voice', hasDraft: false },
      generation: { state: 'stopped' },
    },
  };
  const hub = new ClientSelectionHub([client]);
  const refreshCalls = [];
  const coordinator = new BrowserClientCoordinator({
    hub,
    pending: new Map(),
    lifecycle: {},
    runtimeOptions: {},
    sendCommand: async (type, payload, options) => {
      refreshCalls.push({ type, payload, options });
      client.tabObservation = {
        ...client.tabObservation,
        revision: client.tabObservation.revision + 1,
        observedAt: Date.now(),
      };
      hub.emit('client.activity', { clientId: client.id, client });
      return { observedAt: client.tabObservation.observedAt, revision: client.tabObservation.revision };
    },
  });

  const target = await coordinator.resolvePromptClient(
    { requestId: 'request-stale-observation' },
    { sessionId: 'session-stale-observation' },
    { sourceClientId: client.id },
  );

  assert.equal(target.client.id, client.id);
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].type, 'tab.observation.refresh');
  assert.equal(refreshCalls[0].options.sourceClientId, client.id);
  assert.ok(client.tabObservation.observedAt > staleObservedAt);
});

test('explicit target waits for a fresh Voice-idle observation to become stable', async () => {
  const client = {
    id: 'client-unstable-observation',
    runtime: 'extension',
    ready: true,
    compatible: true,
    session: { id: 'session-unstable-observation' },
    activeRequest: null,
    tabObservation: {
      observerId: 'observer-unstable',
      revision: 1,
      observedAt: Date.now(),
      stableForMs: 0,
      document: { pageReady: true, chatMainReady: true },
      composer: { ready: true, primaryAction: 'voice', hasDraft: false },
      generation: { state: 'idle' },
    },
  };
  const hub = new ClientSelectionHub([client]);
  const refreshCalls = [];
  const coordinator = new BrowserClientCoordinator({
    hub,
    pending: new Map(),
    lifecycle: {},
    runtimeOptions: {},
    sendCommand: async (...args) => refreshCalls.push(args),
  });
  const target = coordinator.resolvePromptClient(
    { requestId: 'request-unstable-observation' },
    { sessionId: 'session-unstable-observation' },
    { sourceClientId: client.id },
  );
  setTimeout(() => {
    client.tabObservation = {
      ...client.tabObservation,
      revision: 2,
      observedAt: Date.now(),
      stableForMs: 800,
    };
    hub.emit('client.activity', { clientId: client.id, client });
  }, 50);

  const selected = await target;

  assert.equal(selected.client.id, client.id);
  assert.equal(refreshCalls.length, 0);
  assert.equal(client.tabObservation.stableForMs, 800);
});

test('pending standalone Bridge command blocks refresh and prompt reservation for its client', async () => {
  const client = {
    id: 'client-pending-command',
    runtime: 'extension',
    ready: true,
    compatible: true,
    session: { id: 'session-pending-command' },
    activeRequest: null,
    tabObservation: {
      observerId: 'observer-pending-command',
      revision: 1,
      observedAt: Date.now() - 60_000,
      stableForMs: 5_000,
      document: { pageReady: true, chatMainReady: true },
      composer: { ready: true, primaryAction: 'voice', hasDraft: false },
      generation: { state: 'stopped' },
    },
  };
  const hub = new ClientSelectionHub([client]);
  const refreshCalls = [];
  const coordinator = new BrowserClientCoordinator({
    hub,
    pending: new Map(),
    lifecycle: {},
    runtimeOptions: {},
    hasPendingCommandForClient: () => true,
    sendCommand: async (...args) => refreshCalls.push(args),
  });

  const result = await coordinator.resolvePromptClient(
    { requestId: 'request-pending-command' },
    { sessionId: 'session-pending-command' },
    { sourceClientId: client.id },
  ).then(() => null, (error) => error);

  assert.equal(result?.code, 'BROWSER_COMMAND_PENDING');
  assert.equal(refreshCalls.length, 0);
  assert.equal(client.tabObservation.revision, 1);
});

test('auto-opened extension prompt waits for a stable Voice-idle observation', async () => {
  const client = {
    id: 'client-new-tab', runtime: 'extension', ready: true, compatible: true, activeRequest: null,
    tabObservation: {
      observerId: 'observer-starting', revision: 1, observedAt: Date.now(), stableForMs: 0,
      document: { pageReady: true, chatMainReady: true },
      composer: { ready: true, primaryAction: 'unknown', hasDraft: false },
      generation: { state: 'idle' },
    },
  };
  const hub = new ClientSelectionHub([client]);
  const coordinator = new BrowserClientCoordinator({
    hub, pending: new Map(), lifecycle: {}, runtimeOptions: {}, sendCommand: async () => ({}),
  });
  const waiting = coordinator.waitForPromptClientIdle({ requestId: 'request-new-tab' }, client, 1_000);
  setTimeout(() => {
    client.tabObservation = {
      ...client.tabObservation,
      observerId: 'observer-stable', revision: 2, observedAt: Date.now(), stableForMs: 800,
      composer: { ready: true, primaryAction: 'voice', hasDraft: false },
    };
    hub.emit('client.activity', { clientId: client.id, client });
  }, 10);

  assert.equal((await waiting).id, client.id);
});

async function finishPrompt(hub, clientId, prompt, answer = 'ok') {
  emitPromptSubmitted(hub, { requestId: prompt.requestId, clientId });
  emitTabObservation(hub, {
    requestId: prompt.requestId,
    clientId,
    answer,
    conversationId: prompt.options.sessionId || 'new',
  });
}


test('health projects the command registry physical release barrier without making the hub its owner', async () => {
  const hub = new ClientSelectionHub([{
    id: 'client-release-projection', ready: true, pageReady: true, composerReady: true, chatMainReady: true,
    url: 'https://chatgpt.com/c/session-release', session: { id: 'session-release' }, activeRequest: null,
  }], { autoRelease: false });
  const bridge = new BrowserBridge(hub);
  const resultPromise = bridge.sendRequest({ message: 'hello', sessionId: 'session-release' }, {}, { fullResponse: true });
  await nextTick();
  const prompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send');
  assert.ok(prompt);
  emitPromptSubmitted(hub, { requestId: prompt.payload.requestId, clientId: 'client-release-projection' });
  const releaseIdentity = bridge.requestStateDiagnostics(prompt.payload.requestId).state;
  const activeRequest = {
    requestId: prompt.payload.requestId,
    leaseId: releaseIdentity.source.leaseId,
    ownerServerInstanceId: releaseIdentity.source.ownerServerInstanceId,
    responseEpoch: releaseIdentity.response.epoch,
    submittedUserTurnKey: 'user-1',
  };
  hub._clients[0].activeRequest = activeRequest;
  const observation = emitTabObservation(hub, {
    requestId: prompt.payload.requestId,
    clientId: 'client-release-projection',
    answer: 'ok',
    conversationId: 'session-release',
    activeRequest,
    leaseId: releaseIdentity.source.leaseId,
    ownerServerInstanceId: releaseIdentity.source.ownerServerInstanceId,
    responseEpoch: releaseIdentity.response.epoch,
  });
  hub._clients[0].tabObservation = observation;
  for (let index = 0; index < 20 && !hub.sent.some((entry) => entry.payload.type === 'request.release'); index += 1) await nextTick();
  const release = hub.sent.find((entry) => entry.payload.type === 'request.release');
  assert.ok(release, 'bridge must start the physical release command after terminal completion');

  let health = bridge.health();
  assert.equal(health.clients[0].releasePending, true);
  assert.equal(health.clients[0].releaseState, 'pending');
  assert.equal(Object.hasOwn(hub.clients[0], 'releasePending'), false, 'hub projection remains free of release lifecycle ownership');

  hub.emit('client.message', {
    clientId: 'client-release-projection',
    payload: {
      type: 'lease.released',
      commandId: release.payload.commandId,
      requestId: release.payload.requestId,
      released: true,
      activeRequest: null,
    },
  });
  await resultPromise;
  health = bridge.health();
  assert.equal(health.clients[0].releasePending, false);
  assert.equal(health.clients[0].releaseState, 'idle');
});

test('prompt target prefers an idle tab already on the requested session', async () => {
  const hub = new ClientSelectionHub([
    { id: 'client-a', ready: true, url: 'https://chatgpt.com/c/session-a', session: { id: 'session-a' }, activeRequest: null },
    { id: 'client-b', ready: true, url: 'https://chatgpt.com/c/session-b', session: { id: 'session-b' }, activeRequest: null },
  ]);
  const bridge = new BrowserBridge(hub);

  const resultPromise = bridge.sendRequest({ message: 'hello', sessionId: 'session-b' }, {}, { fullResponse: true });
  await nextTick();

  const sent = hub.sent.find((entry) => entry.payload.type === 'prompt.send');
  assert.ok(sent);
  assert.equal(sent.clientId, 'client-b');
  assert.equal(sent.payload.options.sessionId, 'session-b');

  await finishPrompt(hub, 'client-b', sent.payload);
  const result = await resultPromise;
  assert.equal(result.answer, 'ok');
});

test('quarantined tabs are never considered schedulable when a clean tab is available', async () => {
  const hub = new ClientSelectionHub([
    { id: 'client-quarantined', ready: true, quarantined: true, quarantineReason: 'release_unproven', url: 'https://chatgpt.com/c/session-b', session: { id: 'session-b' }, activeRequest: null, selected: true },
    { id: 'client-clean', ready: true, url: 'https://chatgpt.com/c/session-b', session: { id: 'session-b' }, activeRequest: null },
  ]);
  const bridge = new BrowserBridge(hub);
  const resultPromise = bridge.sendRequest({ message: 'hello', sessionId: 'session-b' }, {}, { fullResponse: true });
  await nextTick();
  const sent = hub.sent.find((entry) => entry.payload.type === 'prompt.send');
  assert.equal(sent?.clientId, 'client-clean');
  await finishPrompt(hub, 'client-clean', sent.payload);
  assert.equal((await resultPromise).answer, 'ok');
});

test('prompt target asks before using an idle tab that must switch sessions', async () => {
  const hub = new ClientSelectionHub([
    { id: 'client-idle', ready: true, url: 'https://chatgpt.com/c/other-session', session: { id: 'other-session' }, activeRequest: null, focused: true },
    { id: 'client-busy', ready: true, url: 'https://chatgpt.com/c/wanted-session', session: { id: 'wanted-session' }, activeRequest: { requestId: 'remote-running' } },
  ]);
  const bridge = new BrowserBridge(hub);
  const confirmations = [];
  const events = [];

  const resultPromise = bridge.sendRequest({ message: 'hello', sessionId: 'wanted-session' }, { onEvent: (event) => events.push(event) }, {
    fullResponse: true,
    confirmClientSelection: async (details) => { confirmations.push(details); return true; },
  });
  await nextTick();

  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0].message, /switch/i);
  const sent = hub.sent.find((entry) => entry.payload.type === 'prompt.send');
  assert.ok(sent);
  assert.equal(sent.clientId, 'client-idle');
  assert.equal(sent.payload.options.sessionId, 'wanted-session');
  assert.ok(events.some((event) => event.type === 'client.selection.confirmation_required'));
  assert.ok(events.some((event) => event.type === 'session.switch.requested'));

  await finishPrompt(hub, 'client-idle', sent.payload);
  const result = await resultPromise;
  assert.equal(result.answer, 'ok');
});

test('a selected idle tab on another session still requires confirmation before switching', async () => {
  const hub = new ClientSelectionHub([
    { id: 'client-selected', ready: true, selected: true, url: 'https://chatgpt.com/c/other-session', session: { id: 'other-session' }, activeRequest: null },
    { id: 'client-other', ready: true, url: 'https://chatgpt.com/c/third-session', session: { id: 'third-session' }, activeRequest: null },
  ]);
  const bridge = new BrowserBridge(hub);
  const confirmations = [];

  const resultPromise = bridge.sendRequest({ message: 'hello', sessionId: 'wanted-session' }, {}, {
    fullResponse: true,
    confirmClientSelection: async (details) => { confirmations.push(details); return true; },
  });
  await nextTick();

  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].client.id, 'client-selected');
  assert.equal(confirmations[0].reason, 'selected_idle_session_switch');
  const sent = hub.sent.find((entry) => entry.payload.type === 'prompt.send');
  assert.equal(sent.clientId, 'client-selected');
  assert.equal(sent.payload.options.sessionId, 'wanted-session');

  await finishPrompt(hub, 'client-selected', sent.payload);
  assert.equal((await resultPromise).answer, 'ok');
});

test('prompt target refuses idle fallback without confirmation', async () => {
  const hub = new ClientSelectionHub([
    { id: 'client-idle', ready: true, url: 'https://chatgpt.com/c/other-session', session: { id: 'other-session' }, activeRequest: null },
    { id: 'client-busy', ready: true, url: 'https://chatgpt.com/c/wanted-session', session: { id: 'wanted-session' }, activeRequest: { requestId: 'remote-running' } },
  ]);
  const bridge = new BrowserBridge(hub);

  await assert.rejects(
    bridge.sendRequest({ message: 'hello', sessionId: 'wanted-session' }, {}, { fullResponse: true }),
    /Use available idle tab|Run \/tab list/
  );
  assert.equal(hub.sent.some((entry) => entry.payload.type === 'prompt.send'), false);
});

test('extension advertises session presence and verifies session switching before prompt send', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content.js'), 'utf8');
  const featureRuntime = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/featureRuntime.js'), 'utf8');
  const sessionCommands = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/sessionCommands.js'), 'utf8');
  assert.match(source, /session: getCurrentSession\(\)/);
  assert.match(featureRuntime, /createSessionCommands/);
  assert.match(sessionCommands, /waitForSessionId/);
  assert.match(sessionCommands, /Could not switch to the requested ChatGPT session; route\/readiness verification failed\./);
});

test('prompt target never falls back to a busy active tab when no idle tab exists', async () => {
  const hub = new ClientSelectionHub([
    { id: 'client-busy', ready: true, selected: true, url: 'https://chatgpt.com/c/session-a', session: { id: 'session-a' }, activeRequest: { requestId: 'other-running', ownerServerInstanceId: 'other-server' } },
  ]);
  const bridge = new BrowserBridge(hub);

  await assert.rejects(
    bridge.sendRequest({ message: 'must not be sent' }, {}, { fullResponse: true }),
    (err) => {
      assert.match(err.message, /No idle ChatGPT tab is available|Busy tabs/);
      assert.match(err.message, /other-running@server:other-server/);
      return true;
    }
  );
  assert.equal(hub.sent.some((entry) => entry.payload.type === 'prompt.send'), false);
});

test('session navigation reload marks an unproved prompt write uncertain instead of resending it', async () => {
  const hub = new ClientSelectionHub([
    { id: 'client-a', ready: true, selected: true, url: 'https://chatgpt.com/c/session-a', session: { id: 'session-a' }, activeRequest: null },
  ]);
  hub.serverInstanceId = 'server-test';
  const bridge = new BrowserBridge(hub);
  const events = [];

  const resultPromise = bridge.sendRequest(
    { message: 'continue in another session', sessionId: 'session-b' },
    { onEvent: (event) => events.push(event) },
    { fullResponse: true, sourceClientId: 'client-a' }
  );
  await nextTick();

  const firstPrompt = hub.sent.find((entry) => entry.payload.type === 'prompt.send');
  assert.ok(firstPrompt);
  assert.equal(firstPrompt.payload.serverInstanceId, 'server-test');
  hub.emit('client.message', { clientId: 'client-a', payload: { type: 'prompt.accepted', requestId: firstPrompt.payload.requestId } });
  hub.emit('client.message', { clientId: 'client-a', payload: {
    type: 'request.effect.started', requestId: firstPrompt.payload.requestId,
    effectId: `${firstPrompt.payload.requestId}:session.apply:2`, effectType: 'session.apply',
  } });

  const reloadedClient = { id: 'client-a', ready: true, selected: true, url: 'https://chatgpt.com/c/session-b', session: { id: 'session-b' }, activeRequest: null };
  hub._clients[0] = reloadedClient;
  hub.emit('client.ready', reloadedClient);
  await nextTick();

  const prompts = hub.sent.filter((entry) => entry.payload.type === 'prompt.send');
  assert.equal(prompts.length, 1, 'an ambiguous write boundary must never resend the prompt');
  assert.ok(events.some((event) => event.type === 'prompt.reconcile_required_after_navigation'));
  const diagnostics = bridge.requestStateDiagnostics(firstPrompt.payload.requestId);
  assert.equal(diagnostics.state.source.connection, 'reconciling');
  assert.equal(diagnostics.state.blocker, 'recovery');
  assert.ok(diagnostics.history.some((entry) => entry.event.type === 'effect.uncertain'));

  await nextTick();
  const reconcile = hub.sent.find((entry) => entry.payload.type === 'request.effect.reconcile');
  assert.ok(reconcile, 'uncertain effects must reconcile through a typed source-bound read');
  assert.equal(reconcile.payload.effectType, 'session.apply');
  hub.emit('client.message', {
    clientId: 'client-a',
    payload: commandResult(reconcile.payload.commandId, 'request.effect.reconciled', {
      requestId: firstPrompt.payload.requestId,
      effectId: reconcile.payload.effectId,
      reconciliationOutcome: 'uncertain',
      reconciliationReason: 'session_state_not_proved',
      evidence: { sessionId: 'session-b' },
    }),
  });
  await nextTick();

  bridge.cancelActive('test cleanup');
  await assert.rejects(resultPromise, /test cleanup/);
  const cancel = hub.sent.find((entry) => entry.payload.type === 'prompt.cancel');
  assert.equal(cancel?.payload.effect?.kind, 'prompt.cancel');
  assert.equal(cancel?.payload.effect?.retryPolicy, 'if_unconfirmed');
  assert.match(String(cancel?.payload.effect?.preconditionsHash || ''), /^[a-f0-9]{64}$/);
});

test('extension keeps request ownership and duplicate prompt delivery idempotent', async () => {
  const [commands, requestState] = await Promise.all([
    fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestPromptCommands.js'), 'utf8'),
    fs.readFile(path.resolve('tools/chrome-bridge-extension/content/requestState.js'), 'utf8'),
  ]);
  assert.match(commands, /REQUEST_STATE\.createRequestState/);
  assert.match(commands, /prompt\.duplicate_ignored/);
  assert.match(commands, /activeRequest\.requestId === requestId/);
  assert.match(requestState, /ownerServerInstanceId/);
  assert.match(requestState, /responseEpoch/);
  assert.doesNotMatch(requestState, /generating: Boolean\(runtime\.generating\)/);
  assert.doesNotMatch(requestState, /stopButtonVisible: Boolean\(runtime\.stopButtonVisible\)/);
});

test('extension reload observes a reconnect that arrives immediately after command acknowledgement', async () => {
  const original = {
    id: 'client-reload',
    ready: true,
    selected: true,
    browserTabId: 42,
    launchToken: 'bridge-real-e2e-wiretoken123',
    extensionVersion: '0.4.20',
    extensionProtocolVersion: 5,
    compatible: false,
    compatibility: { compatible: false, status: 'extension_outdated' },
    connectedAt: new Date(Date.now() - 10_000).toISOString(),
  };
  const hub = new ClientSelectionHub([original]);
  const baseSend = hub.sendToClient.bind(hub);
  hub.sendToClient = (clientId, payload) => {
    const client = baseSend(clientId, payload);
    if (payload.type === 'extension.reload') {
      setImmediate(() => {
        hub.emit('client.message', {
          clientId,
          payload: commandResult(payload.commandId, 'extension.reload.scheduled', { scheduled: true }),
        });
        const reconnected = {
          ...original,
          extensionVersion: '0.6.1',
          connectedAt: new Date().toISOString(),
        };
        hub._clients[0] = reconnected;
        hub.emit('client.ready', reconnected);
      });
    }
    return client;
  };

  const bridge = new BrowserBridge(hub, null, null, { publicBaseUrl: 'http://127.0.0.1:18181' });
  const result = await bridge.reloadExtension({
    sourceClientId: original.id,
    expectedVersion: '0.6.1',
    timeoutMs: 2_000,
  });

  assert.equal(result.accepted.scheduled, true);
  assert.equal(result.reconnected.extensionVersion, '0.6.1');
  const reloadCommands = hub.sent.filter((entry) => entry.payload.type === 'extension.reload');
  assert.equal(reloadCommands.length, 1);
  assert.equal(hub.reloadControlCalls.length, 1);
  assert.deepEqual(reloadCommands[0].payload.connection, { serverUrl: 'http://127.0.0.1:18181' });
  assert.equal(reloadCommands[0].payload.expectedVersion, '0.6.1');
  assert.equal(reloadCommands[0].payload.sourceTabId, 42);
  assert.equal(reloadCommands[0].payload.sourceLaunchToken, 'bridge-real-e2e-wiretoken123');
  assert.equal(reloadCommands[0].payload.temporaryServerUrl, 'http://127.0.0.1:18181');
});

test('extension reload replaces an owned tab when page-owned reload cannot be armed', async () => {
  const original = {
    id: 'client-page-reload-fallback',
    ready: true,
    selected: true,
    browserTabId: 42,
    launchToken: 'bridge-real-e2e-fallback123',
    url: 'https://chatgpt.com/c/session-a',
    extensionVersion: '1.0.14',
    clientVersion: '3.0.14',
    connectedAt: new Date(Date.now() - 10_000).toISOString(),
  };
  const hub = new ClientSelectionHub([original]);
  const openedUrls = [];
  const baseSend = hub.sendToClient.bind(hub);
  hub.sendToClient = (clientId, payload) => {
    const client = baseSend(clientId, payload);
    if (payload.type === 'extension.reload') {
      setImmediate(() => hub.emit('client.message', {
        clientId,
        payload: commandResult(payload.commandId, 'extension.reload.scheduled', { scheduled: true }),
      }));
    }
    if (payload.type === 'browser.tab.close-owned') {
      setImmediate(() => hub.emit('client.message', {
        clientId,
        payload: commandResult(payload.commandId, 'browser.tab.owned_closing', {
          tabId: payload.tabId, launchToken: payload.expectedLaunchToken, closing: true,
        }),
      }));
    }
    return client;
  };

  const bridge = new BrowserBridge(hub, null, null, {
    publicBaseUrl: 'http://127.0.0.1:18181',
    openExternalUrl: async (url) => {
      openedUrls.push(url);
      const launchToken = new URLSearchParams(new URL(url).hash.replace(/^#/, '')).get('chatgpt-bridge-launch');
      assert.match(launchToken, /^bridge-recovery-/);
      assert.equal(launchToken.startsWith('bridge-reload-'), false, 'replacement ownership must not use the temporary reload-token namespace');
      // Match the real extension contract: every bridge-reload-* token is treated
      // as temporary connection metadata and omitted from the hello handshake.
      const reportedLaunchToken = launchToken.startsWith('bridge-reload-') ? '' : launchToken;
      const replacement = {
        id: 'client-replacement', ready: true, selected: false, browserTabId: 77,
        launchToken: reportedLaunchToken, url: 'https://chatgpt.com/c/session-a', extensionVersion: '2.0.0', clientVersion: '4.0.0',
        connectedAt: new Date().toISOString(), compatible: true, compatibility: { compatible: true },
      };
      hub._clients.push(replacement);
      setImmediate(() => hub.emit('client.ready', replacement));
    },
  });

  const result = await bridge.reloadExtension({
    sourceClientId: original.id,
    expectedVersion: '2.0.0',
    timeoutMs: 2_000,
  });

  assert.equal(result.recovery.used, true);
  assert.equal(result.recovery.reason, 'page_reload_not_armed');
  assert.equal(result.reconnected.id, 'client-replacement');
  assert.equal(openedUrls.length, 1);
  const close = hub.sent.find((entry) => entry.payload.type === 'browser.tab.close-owned');
  assert.ok(close);
  assert.equal(close.clientId, 'client-replacement');
  assert.equal(close.payload.tabId, 42);
  assert.equal(close.payload.expectedLaunchToken, 'bridge-real-e2e-fallback123');
});

test('extension reload falls back to the deployed maintenance page only after the protocol command fails', async () => {
  const original = {
    id: 'client-maintenance-bootstrap',
    ready: true,
    selected: true,
    browserTabId: 42,
    launchToken: 'bridge-real-e2e-maintenance123',
    url: 'https://chatgpt.com/c/maintenance-bootstrap',
    origin: 'chrome-extension://dchijcgcljbehhihflegffnhkambmmjb',
    extensionVersion: '2.3.0',
    clientVersion: '4.3.0',
    extensionProtocolVersion: 5,
    compatible: false,
    compatibility: { compatible: false, status: 'extension_outdated' },
    activeRequest: null,
    connectedAt: new Date(Date.now() - 10_000).toISOString(),
  };
  const hub = new ClientSelectionHub([original]);
  const baseSend = hub.sendToClient.bind(hub);
  hub.sendToClient = (clientId, payload) => {
    const client = baseSend(clientId, payload);
    if (payload.type === 'extension.reload') {
      setImmediate(() => hub.emit('client.message', {
        clientId,
        payload: {
          type: 'command.error',
          commandId: payload.commandId,
          code: 'OUTDATED_RELOAD_PATH',
          message: 'old runtime could not persist reload result',
        },
      }));
    }
    return client;
  };
  const openedUrls = [];
  const bridge = new BrowserBridge(hub, null, null, {
    publicBaseUrl: 'http://127.0.0.1:18181',
    openExternalUrl: async (url) => {
      openedUrls.push(url);
      const parsed = new URL(url);
      assert.equal(`${parsed.protocol}//${parsed.host}`, original.origin);
      assert.equal(parsed.pathname, '/maintenance-reload.html');
      assert.equal(parsed.searchParams.get('expectedVersion'), '2.3.11');
      assert.equal(parsed.searchParams.get('sourceTabId'), '42');
      assert.equal(parsed.searchParams.get('sourceLaunchToken'), original.launchToken);
      assert.equal(parsed.searchParams.get('serverUrl'), 'http://127.0.0.1:18181');
      const reconnected = {
        ...original,
        id: 'client-maintenance-bootstrap-new',
        extensionVersion: '2.3.11',
        clientVersion: '4.3.9',
        compatible: true,
        compatibility: { compatible: true, status: 'compatible' },
        connectedAt: new Date().toISOString(),
      };
      hub._clients = [reconnected];
      setImmediate(() => hub.emit('client.ready', reconnected));
    },
  });

  const result = await bridge.reloadExtension({
    sourceClientId: original.id,
    expectedVersion: '2.3.11',
    timeoutMs: 2_000,
    allowMaintenancePageBootstrap: true,
  });

  assert.equal(result.reconnected.extensionVersion, '2.3.11');
  assert.equal(result.recovery.reason, 'maintenance_page_after_command_failure');
  assert.equal(openedUrls.length, 1);
  assert.equal(hub.sent.some((entry) => entry.payload.type === 'extension.reload'), true);
});

test('extension reload opens the maintenance page when an accepted restart does not reconnect the ChatGPT tab', async () => {
  const original = {
    id: 'client-maintenance-after-ack',
    ready: true,
    selected: true,
    browserTabId: 42,
    launchToken: '',
    url: 'https://chatgpt.com/c/maintenance-after-ack',
    origin: 'chrome-extension://dchijcgcljbehhihflegffnhkambmmjb',
    extensionVersion: '2.3.4',
    clientVersion: '4.3.3',
    extensionProtocolVersion: 5,
    compatible: true,
    compatibility: { compatible: true, status: 'compatible' },
    activeRequest: null,
    connectedAt: new Date(Date.now() - 10_000).toISOString(),
  };
  const hub = new ClientSelectionHub([original]);
  const baseSend = hub.sendToClient.bind(hub);
  hub.sendToClient = (clientId, payload) => {
    const client = baseSend(clientId, payload);
    if (payload.type === 'extension.reload') {
      setImmediate(() => hub.emit('client.message', {
        clientId,
        payload: commandResult(payload.commandId, 'extension.reload.scheduled', {
          scheduled: true,
          pageReload: { armed: false },
        }),
      }));
    }
    return client;
  };
  const openedUrls = [];
  const bridge = new BrowserBridge(hub, null, null, {
    publicBaseUrl: 'http://127.0.0.1:18181',
    openExternalUrl: async (url) => {
      openedUrls.push(url);
      const parsed = new URL(url);
      assert.equal(`${parsed.protocol}//${parsed.host}`, original.origin);
      assert.equal(parsed.pathname, '/maintenance-reload.html');
      const reconnected = {
        ...original,
        id: 'client-maintenance-after-ack-new',
        extensionVersion: '2.3.11',
        clientVersion: '4.3.9',
        connectedAt: new Date().toISOString(),
      };
      hub._clients = [reconnected];
      setImmediate(() => hub.emit('client.ready', reconnected));
    },
  });

  const result = await bridge.reloadExtension({
    sourceClientId: original.id,
    expectedVersion: '2.3.11',
    timeoutMs: 3_000,
    allowMaintenancePageBootstrap: true,
  });

  assert.equal(result.reconnected.extensionVersion, '2.3.11');
  assert.equal(result.recovery.reason, 'maintenance_page_after_stalled_command');
  assert.equal(result.accepted.bootstrapPage, true);
  assert.equal(openedUrls.length, 1);
});

test('extension reload accepts a compatible reconnect even when the old runtime loses its terminal result', async () => {
  const original = {
    id: 'client-reconnect-before-result',
    ready: true,
    selected: true,
    browserTabId: 51,
    launchToken: 'bridge-real-e2e-reconnect123',
    url: 'https://chatgpt.com/c/reconnect-before-result',
    origin: 'chrome-extension://dchijcgcljbehhihflegffnhkambmmjb',
    extensionVersion: '2.3.11',
    clientVersion: '4.3.9',
    extensionProtocolVersion: 5,
    compatible: true,
    compatibility: { compatible: true, status: 'compatible' },
    activeRequest: null,
    connectedAt: new Date(Date.now() - 10_000).toISOString(),
  };
  const hub = new ClientSelectionHub([original]);
  const baseSend = hub.sendToClient.bind(hub);
  hub.sendToClient = (clientId, payload) => {
    const client = baseSend(clientId, payload);
    if (payload.type === 'extension.reload') {
      const reconnected = { ...original, connectedAt: new Date().toISOString() };
      hub._clients = [reconnected];
      setImmediate(() => hub.emit('client.ready', reconnected));
    }
    return client;
  };
  const bridge = new BrowserBridge(hub, null, null, { publicBaseUrl: 'http://127.0.0.1:18181' });
  const result = await bridge.reloadExtension({
    sourceClientId: original.id,
    expectedVersion: '2.3.11',
    timeoutMs: 2_000,
  });
  assert.equal(result.recovery.used, false);
  assert.equal(result.recovery.reason, 'reconnected_before_terminal_result');
  assert.equal(result.reconnected.extensionVersion, '2.3.11');
  assert.equal(hub.reloadControlCalls.length, 1);
});
