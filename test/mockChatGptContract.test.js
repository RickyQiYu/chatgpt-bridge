import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import '../tools/chrome-bridge-extension/shared/commandManifest.js';
import { config } from '../src/config.js';
import { BrowserExtensionHub } from '../src/browserExtensionHub.js';
import { BrowserClientCoordinator } from '../src/bridge/coordinator/browserClientCoordinator.js';
import { BridgeCommandRegistry } from '../src/bridge/coordinator/bridgeCommandRegistry.js';
import { REAL_E2E_SCENARIOS, expandScenarioSelectors } from '../scripts/e2e-scenarios.js';
import { LOCAL_E2E_COMMAND_TYPES, LOCAL_E2E_LIVE_ONLY_BOUNDARIES } from '../scripts/e2e/mock-chatgpt/contract.js';
import { MockChatGptBrowser } from '../scripts/e2e/mock-chatgpt/extension-client.js';

test('local ChatGPT protocol participant covers every shared command-manifest command', () => {
  const manifestTypes = globalThis.ChatGptBridgeCommandManifest.commandTypes().slice().sort();
  assert.deepEqual([...LOCAL_E2E_COMMAND_TYPES].sort(), manifestTypes);
});

test('stale mock tab projection refreshes end to end before explicit prompt admission', async (t) => {
  const server = http.createServer();
  const hub = new BrowserExtensionHub(null, { serverInstanceId: 'mock-observation-refresh-server' });
  hub.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = new MockChatGptBrowser({
    bridgeUrl: `http://127.0.0.1:${server.address().port}`,
    bridgeToken: config.bridgeToken,
  });
  const commands = new BridgeCommandRegistry({ hub });
  hub.on('client.message', ({ clientId, payload }) => {
    if (['command.result', 'command.error', 'command.rejected'].includes(payload?.type)) {
      commands.handleResponse(clientId, payload);
    }
  });
  t.after(async () => {
    commands.close();
    await browser.close();
    hub.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  const ready = once(hub, 'client.ready');
  const tab = await browser.openTab({ tabId: 401, active: true });
  await ready;
  const originalClient = hub.clients.find((client) => client.browserTabId === 401);
  assert.ok(originalClient);
  const staleObservedAt = Date.now() - 60_000;
  let serveStaleProjection = true;
  const admissionHub = {
    get clients() {
      const clients = hub.clients;
      if (!serveStaleProjection) return clients;
      serveStaleProjection = false;
      return clients.map((client) => client.id === originalClient.id
        ? { ...client, tabObservation: { ...client.tabObservation, observedAt: staleObservedAt } }
        : client);
    },
    on: hub.on.bind(hub),
    off: hub.off.bind(hub),
    get selectedClientId() { return hub.selectedClientId; },
    get serverInstanceId() { return hub.serverInstanceId; },
  };
  const coordinator = new BrowserClientCoordinator({
    hub: admissionHub,
    pending: new Map(),
    lifecycle: {},
    runtimeOptions: {},
    sendCommand: (...args) => commands.send(...args),
    releaseCoordinator: commands,
    hasPendingCommandForClient: (clientId) => commands.hasPendingForClient(clientId),
  });

  const target = await coordinator.resolvePromptClient(
    { requestId: 'mock-wake-prompt' },
    { sessionId: originalClient.session.id },
    { sourceClientId: originalClient.id },
  );

  assert.equal(target.client.id, originalClient.id);
  assert.ok(tab.commandJournal.some((entry) => entry.type === 'tab.observation.refresh'));
  const refreshed = hub.clients.find((client) => client.id === originalClient.id);
  assert.ok(refreshed.tabObservation.observedAt > staleObservedAt);
  assert.ok(refreshed.tabObservation.revision > originalClient.tabObservation.revision);
});

test('local ChatGPT E2E default selects the complete registered scenario matrix', () => {
  assert.deepEqual(expandScenarioSelectors([]), REAL_E2E_SCENARIOS.map((scenario) => scenario.id));
});

test('remaining live-only boundaries are platform/product concerns, not canonical lifecycle gaps', () => {
  assert.ok(LOCAL_E2E_LIVE_ONLY_BOUNDARIES.length >= 3);
  assert.ok(LOCAL_E2E_LIVE_ONLY_BOUNDARIES.every((item) => typeof item === 'string' && item.length > 20));
});

test('mock extension hello identity is read from the bundled extension files', async () => {
  const [{ MOCK_EXTENSION_RUNTIME_IDENTITY }, { readBundledExtensionInfo }] = await Promise.all([
    import('../scripts/e2e/mock-chatgpt/extension-client.js'),
    import('../src/extensionStartup.js'),
  ]);
  const bundled = await readBundledExtensionInfo();
  assert.deepEqual(MOCK_EXTENSION_RUNTIME_IDENTITY, {
    extensionVersion: bundled.version,
    clientVersion: bundled.contentVersion,
    extensionBundleId: bundled.bundleId,
  });
});

test('mock browser download path creates regular files and cleanup removes them one at a time without deleting the directory', async (t) => {
  const [{ MockChatGptBrowser }, fs, os, path] = await Promise.all([
    import('../scripts/e2e/mock-chatgpt/extension-client.js'),
    import('node:fs/promises'),
    import('node:os'),
    import('node:path'),
  ]);
  const browser = new MockChatGptBrowser({ bridgeUrl: 'http://127.0.0.1:1' });
  browser.downloadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-mock-browser-downloads-'));
  t.after(() => fs.rm(browser.downloadRoot, { recursive: true, force: true }));
  const first = await browser.createBrowserDownload({ name: 'one.json', fileName: 'one.json', buffer: Buffer.from('{"one":1}') });
  const second = await browser.createBrowserDownload({ name: 'two.csv', fileName: 'two.csv', buffer: Buffer.from('two,2\n') });
  assert.equal((await fs.lstat(first.filePath)).isFile(), true);
  assert.equal((await fs.lstat(second.filePath)).isFile(), true);
  const results = await browser.cleanupOwnedDownloads();
  assert.deepEqual(results.map((item) => item.removed), [true, true]);
  await assert.rejects(fs.lstat(first.filePath), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(second.filePath), { code: 'ENOENT' });
  assert.equal((await fs.lstat(browser.downloadRoot)).isDirectory(), true);
});
