import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('requested observation refresh waits for a fresh result when the observer is already collecting', async () => {
  const context = vm.createContext({
    Date,
    MutationObserver: class MutationObserver { observe() {} disconnect() {} },
    Promise,
    clearTimeout,
    console,
    setImmediate,
    setTimeout,
  });
  const source = await fs.readFile(
    new URL('../tools/chrome-bridge-extension/content/pageStatusRuntime.js', import.meta.url),
    'utf8',
  );
  vm.runInContext(source, context, { filename: 'pageStatusRuntime.js' });

  const oldObservation = { observerId: 'observer-1', revision: 1, observedAt: Date.now() - 60_000 };
  const freshObservation = { observerId: 'observer-1', revision: 2, observedAt: Date.now() };
  let emitted = [];
  const runtime = context.ChatGptPageStatusRuntime.createPageStatusRuntime({
    CONFIG: {},
    TAB_OBSERVATION_CORE: {},
    TAB_OBSERVER_FACTORY: {
      createTabObserver(options) {
        return {
          start() { options.emit(oldObservation); },
          stop() {},
          force(reason) {
            setImmediate(() => {
              freshObservation.observedAt = Date.now();
              freshObservation.reason = reason;
              options.emit(freshObservation);
            });
            return Promise.resolve(oldObservation);
          },
        };
      },
    },
    chatPageReadiness: () => ({ ready: true, chatMainReady: true, composerReady: true }),
    diagnostic: () => {},
    findChatMain: () => ({}),
    getActiveRequest: () => null,
    getCurrentSession: () => ({ id: 'session-1' }),
    isGenerating: () => false,
    publicRequestStatus: () => null,
    readObservedTurnContext: () => null,
    readAssistantSnapshot: () => ({}),
    readLatestAssistantSnapshot: () => ({ answer: 'ready', turnKey: 'assistant-1', phase: 'ASSISTANT_FINAL', hasFinalMessage: true }),
    send: (payload) => emitted.push(payload),
  });

  const observed = await runtime.handleTabObservationRefresh({
    commandId: 'refresh-observation-1',
    reason: 'bridge.prompt_admission',
  });

  assert.equal(observed.observedAt, freshObservation.observedAt);
  assert.ok(observed.observedAt > oldObservation.observedAt);
  assert.equal(observed.reason, 'bridge.prompt_admission');
  assert.ok(emitted.some((payload) => payload.type === 'tab.observation' && payload.observedAt === observed.observedAt));
  assert.ok(emitted.some((payload) => payload.type === 'tab.observation.refreshed'
    && payload.commandId === 'refresh-observation-1'
    && payload.revision === observed.revision));
});
