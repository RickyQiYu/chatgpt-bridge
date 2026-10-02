import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { REAL_E2E_SCENARIOS } from '../scripts/e2e-scenarios.js';
import { MockExtensionTab } from '../scripts/e2e/mock-chatgpt/extension-client.js';
import { MockChatGptStateMachine } from '../scripts/e2e/mock-chatgpt/state-machine.js';
import { ExtensionMessageType } from '../src/bridge/protocol/v5.js';

const fixtureUrl = new URL('./fixtures/e2e-real/successful-run-e2e48.json', import.meta.url);

async function fixture() {
  return JSON.parse(await fs.readFile(fixtureUrl, 'utf8'));
}

async function productionObservationCore() {
  const source = await fs.readFile(new URL('../tools/chrome-bridge-extension/observation/tabObservationCore.js', import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: 'tabObservationCore.js' });
  return context.ChatGptTabObservationCore;
}

function percentages(output) {
  return [...new Set((output.progressItems || []).map((item) => Number.parseInt(item.text, 10)).filter(Number.isFinite))];
}

test('reviewed successful real run covers the same complete local scenario matrix', async () => {
  const recorded = await fixture();
  assert.equal(recorded.status, 'passed');
  assert.deepEqual(REAL_E2E_SCENARIOS.map((scenario) => scenario.id).slice().sort(), recorded.scenarioIds.slice().sort());
});

test('mock startup observation uses the production TabObservation schema and states', async () => {
  const recorded = await fixture();
  const state = new MockChatGptStateMachine({ tabId: 480 });
  const tab = new MockExtensionTab({
    bridgeUrl: 'http://127.0.0.1:1',
    tabId: 480,
    active: false,
    state,
    deliveryNoise: false,
  });
  const observation = tab.createObservation();
  const production = await productionObservationCore();
  const normalized = production.normalizeTabObservation({
    url: state.url,
    title: 'ChatGPT',
    session: state.sessionProjection(),
    presence: {
      visibilityState: 'hidden',
      focused: false,
      documentReadyState: 'interactive',
      chatMainReady: true,
      composerReady: true,
      primaryComposerAction: observation.composer.primaryAction,
      composerHasDraft: observation.composer.hasDraft,
      pageReady: true,
    },
    snapshot: {},
    turnContext: null,
    activeRequest: null,
    generating: false,
  });
  assert.equal(observation.schemaVersion, production.SCHEMA_VERSION);
  assert.equal(observation.schemaVersion, recorded.startupObservation.schemaVersion);
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(observation.document, plain(normalized.document));
  assert.deepEqual(observation.composer, plain(normalized.composer));
  assert.deepEqual(observation.generation, plain(normalized.generation));
  assert.deepEqual(observation.artifact, plain(normalized.artifact));
  assert.deepEqual(observation.blocker, plain(normalized.blocker));
  assert.deepEqual(observation.error, plain(normalized.error));
  assert.equal(observation.visibility, recorded.startupObservation.visibility);
  assert.equal(observation.focused, recorded.startupObservation.focused);
  assert.equal('sendVisible' in observation.composer, false);
  assert.equal('sendVisible' in observation.generation, false);
});

test('mock reasoning reproduces the inconclusive first attempt and complete second attempt from real E2E 48', async () => {
  const recorded = await fixture();
  const state = new MockChatGptStateMachine({ tabId: 481 });
  const attempts = [];
  for (const suffix of ['R1', 'R2']) {
    const prompt = `This is a reasoning test. TEST_LOCAL_${suffix}_BEGIN then TEST_LOCAL_${suffix}_FINISH.`;
    state.appendUser(prompt);
    const observed = [];
    await state.generate(prompt, { onChange: async () => observed.push(state.outputSnapshot()) });
    attempts.push([...new Set(observed.flatMap((output) => percentages(output)))]);
  }
  assert.deepEqual(attempts[0], recorded.reasoningAttempts[0].progressPercentages);
  assert.deepEqual(attempts[1], recorded.reasoningAttempts[1].progressPercentages);
});

test('mock transport deterministically replays exact envelopes and emits one late stale observation', async () => {
  const tab = new MockExtensionTab({ bridgeUrl: 'http://127.0.0.1:1', tabId: 482, deliveryNoise: true });
  const sent = [];
  tab.connected = true;
  tab.ws = { readyState: 1, send: (value) => sent.push(JSON.parse(String(value))) };
  await tab.send(ExtensionMessageType.TAB_OBSERVATION, { type: 'tab.observation', observation: { revision: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].messageId, sent[1].messageId);
  assert.equal(sent[0].source.sequence, sent[1].source.sequence);
  assert.equal(tab.duplicateDeliveryCount, 1);

  sent.length = 0;
  tab.state.appendUser('Output exactly NOISE_OK.', { requestId: 'noise-request', leaseId: 'noise-lease', ownerServerInstanceId: 'noise-server', responseEpoch: 0 });
  tab.state.generating = true;
  await tab.publishObservation('generation-started');
  tab.state.generating = false;
  const assistant = { role: 'assistant', key: 'assistant-noise', messageId: 'assistant-noise', text: 'NOISE_OK', final: true, progressItems: [], artifacts: [] };
  tab.state.turns.push(assistant);
  tab.state.revision += 1;
  await tab.publishObservation('generation-completed');
  const observations = sent.filter((item) => item.messageType === ExtensionMessageType.TAB_OBSERVATION);
  assert.ok(observations.some((item) => item.body.reason === 'mock.late-stale-observation'));
  assert.equal(tab.lateObservationCount, 1);
});

test('mock content reconnect restarts document readiness and background replay budgets', async () => {
  const tab = new MockExtensionTab({ bridgeUrl: 'http://127.0.0.1:1', tabId: 483, deliveryNoise: true });
  tab.documentReadyState = 'complete';
  tab.staleObservationCandidate = { revision: 99 };
  tab.duplicateBudgets.set(ExtensionMessageType.TAB_OBSERVATION, 0);
  tab.duplicateBudgets.set(ExtensionMessageType.EFFECT_SUCCEEDED, 0);
  tab.ws = { terminate() {} };
  let observedAtConnect = null;
  tab.connect = async function connectStub() {
    observedAtConnect = {
      documentReadyState: this.documentReadyState,
      tabObservationBudget: this.duplicateBudgets.get(ExtensionMessageType.TAB_OBSERVATION),
      effectSucceededBudget: this.duplicateBudgets.get(ExtensionMessageType.EFFECT_SUCCEEDED),
      staleObservationCandidate: this.staleObservationCandidate,
    };
    return this;
  };
  await tab.reconnect({ replaceBackground: true, replaceContent: true });
  assert.deepEqual(observedAtConnect, {
    documentReadyState: 'interactive',
    tabObservationBudget: 2,
    effectSucceededBudget: 1,
    staleObservationCandidate: null,
  });
});
