import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { parseCapturedHtml } from './helpers/offlineChatDom.js';

async function loadComposerCommands() {
  const source = await fs.readFile(
    path.resolve('tools/chrome-bridge-extension/content/composerCommands.js'),
    'utf8',
  );
  const context = vm.createContext({ console });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'composerCommands.js' });
  return context.ChatGptComposerCommands.createComposerCommands({
    isPrimaryChatSurfaceElement: () => true,
    isVisible: () => true,
  });
}

function button(attributes = {}) {
  const values = new Map(Object.entries(attributes).map(([key, value]) => [key, String(value)]));
  return {
    disabled: false,
    textContent: attributes.textContent || '',
    getAttribute(name) {
      return values.has(name) ? values.get(name) : null;
    },
  };
}

function rootFor({ stop = null, send = null, voice = null } = {}) {
  return {
    matches() { return false; },
    querySelectorAll(selector) {
      if (selector === 'button[type="submit"]') return stop ? [stop] : [];
      if (selector === '[role="button"][type="submit"]') return [];
      if (selector === '[data-testid="send-button"]') return send ? [send] : [];
      if (selector === '[data-testid*="send" i]') return send ? [send] : [];
      if (selector === 'button[aria-label*="Send" i]') return [];
      if (selector === '[role="button"][aria-label*="Send" i]') return [];
      if (selector === 'button, [role="button"]') return [stop, send, voice].filter(Boolean);
      return [];
    },
  };
}

test('steering does not treat a submit-typed stop control as a send button', async () => {
  const commands = await loadComposerCommands();
  const stop = button({
    type: 'submit',
    'data-testid': 'stop-button',
    'aria-label': 'Stop generating',
  });

  assert.equal(commands.findSendButton([rootFor({ stop })]), null);
});

test('steering still selects the real send control when it becomes available', async () => {
  const commands = await loadComposerCommands();
  const stop = button({
    type: 'submit',
    'data-testid': 'stop-button',
    'aria-label': 'Stop generating',
  });
  const send = button({
    type: 'submit',
    'data-testid': 'send-button',
    'aria-label': 'Send prompt',
  });

  assert.equal(commands.findSendButton([rootFor({ stop, send })]), send);
});

test('primary composer action distinguishes Stop, Send draft, Voice idle, and unknown', async () => {
  const commands = await loadComposerCommands();
  const html = await fs.readFile(path.resolve('test/fixtures/chat-dom/composer-primary-actions.html'), 'utf8');
  const cases = parseCapturedHtml(html).querySelectorAll('[data-case]');
  const stop = cases.find((item) => item.getAttribute('data-case') === 'stop');
  const send = cases.find((item) => item.getAttribute('data-case') === 'send');
  const voice = cases.find((item) => item.getAttribute('data-case') === 'voice');
  const unknown = cases.find((item) => item.getAttribute('data-case') === 'unknown');

  assert.equal(commands.readPrimaryComposerAction([stop]), 'stop');
  assert.equal(commands.readPrimaryComposerAction([send]), 'send');
  assert.equal(commands.readPrimaryComposerAction([voice]), 'voice');
  assert.equal(commands.readPrimaryComposerAction([unknown]), 'unknown');
});

test('a submit-typed Voice control is classified as idle, not as Send', async () => {
  const commands = await loadComposerCommands();
  const html = await fs.readFile(path.resolve('test/fixtures/chat-dom/composer-primary-actions.html'), 'utf8');
  const voiceSubmit = parseCapturedHtml(html).querySelectorAll('[data-case="voice-submit"]')[0];

  assert.equal(commands.readPrimaryComposerAction([voiceSubmit]), 'voice');
});
