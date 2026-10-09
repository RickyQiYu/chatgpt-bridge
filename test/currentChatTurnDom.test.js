import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createAssistantFixtureParser } from './helpers/offlineChatDom.js';

test('shared user and thought parent still selects the native assistant message root', async () => {
  const parser = await createAssistantFixtureParser();
  const base = new URL('./fixtures/chat-dom/captured/shared-turn-boundary/', import.meta.url);
  const contract = JSON.parse(await fs.readFile(new URL('01-shared-turn.contract.json', base), 'utf8'));
  const html = await fs.readFile(new URL(contract.source.html, base), 'utf8');
  const result = parser.parseRequestWithoutAssistant(html, { submittedUserTurnKey: contract.submittedUserTurnKey });
  assert.equal(result.userTurnKey, contract.submittedUserTurnKey);
  assert.equal(result.turnKey, contract.assistantTurnKey);
  for (const text of contract.answerIncludes) assert.ok(result.answer.includes(text), text);
  for (const text of contract.answerExcludes) assert.ok(!result.answer.includes(text), text);
  assert.ok(!result.progressItems.some((item) => item.text.includes('A scheduled wake')));
  assert.ok(!result.thinking.includes('A scheduled wake'));
  assert.ok(!result.progress.includes('A scheduled wake'));
  assert.ok(!result.progressItems.some((item) => item.text.includes('A completed Planner response.')));
  assert.equal(parser.snapshots.getTurnNodes().filter((node) => parser.snapshots.turnRole(node) === 'assistant').length, 1);
});

test('native answer discovery preserves sibling artifacts within its owned assistant branch', async () => {
  const parser = await createAssistantFixtureParser();
  const html = await fs.readFile(new URL('./fixtures/chat-dom/captured/shared-turn-boundary/02-native-answer-artifact.html', import.meta.url), 'utf8');
  const result = parser.parseRequestWithoutAssistant(html, { submittedUserTurnKey: 'turn-current::user' });
  assert.equal(result.answer, 'Answer text\n\n[Download result.zip](sandbox:/mnt/data/result.zip)');
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].name, 'result.zip');
  assert.equal(result.artifacts[0].phase, 'READY');
  assert.ok(!result.progressItems.some((item) => item.text === 'Prompt'));
  assert.equal(parser.snapshots.getTurnNodes().filter((node) => parser.snapshots.turnRole(node) === 'assistant').length, 1);
});

test('native answer ownership retains generating artifacts and excludes user and future attachments', async () => {
  const parser = await createAssistantFixtureParser();
  let html = await fs.readFile(new URL('./fixtures/chat-dom/captured/shared-turn-boundary/02-native-answer-artifact.html', import.meta.url), 'utf8');
  html = html.replace('<p>Prompt</p>', '<p>Prompt</p><div data-testid="artifact-file"><a href="sandbox:/mnt/data/user.zip" download="user.zip">User attachment</a></div>')
    .replace('<div data-testid="artifact-file"><a href="sandbox:/mnt/data/result.zip"', '<div data-testid="artifact-file" data-state="generating" aria-busy="true"><a href="sandbox:/mnt/data/result.zip"')
    .replace('</main>', `<div data-turn-key="turn-later"><div class="group/user-message" data-chatgpt-search-message-ids="later-user"><p>Later prompt</p></div><div class="assistant-branch"><span hidden data-chatgpt-agent-turn-start></span><div data-content-search-unit-key="later-answer" data-chatgpt-search-message-ids="later-answer"><p>Later answer</p></div><div data-testid="artifact-file"><a href="sandbox:/mnt/data/later.zip" download="later.zip">Later download</a></div></div></div></main>`);
  const result = parser.parseRequestWithoutAssistant(html, { submittedUserTurnKey: 'turn-current::user' });
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].name, 'result.zip');
  assert.equal(result.artifacts[0].phase, 'GENERATING');
  assert.ok(!result.answer.includes('Later answer'));
  assert.ok(!result.raw.includes('User attachment'));
});

test('an optimistic ChatGPT turn cannot become a submitted user anchor before native identity arrives', async () => {
  const parser = await createAssistantFixtureParser();
  const root = parser.mount(`<main><div data-turn-key="pending-chatgpt-submit">
    <div class="group/user-message" data-chatgpt-search-message-ids="optimistic-message"><p>A scheduled wake</p></div>
  </div></main>`);
  const user = parser.snapshots.getTurnNodes().find((node) => parser.snapshots.turnRole(node) === 'user');
  assert.equal(parser.snapshots.turnKey(user), '');
  const request = {
    requestId: 'request-native-identity', submittedUserTurnKey: '', submittedUserTurnIndex: -1,
    pendingSubmittedTurnExpectedText: 'A scheduled wake',
    update(_type, data) { Object.assign(this, data); },
  };
  const turn = root.querySelector('[data-turn-key]');
  const timer = setTimeout(() => turn.setAttribute('data-turn-key', 'native-user-id'), 10);
  try {
    const anchor = await parser.snapshots.waitForSubmittedUserTurnAnchor(request, new Set(), { timeoutMs: 500 });
    assert.equal(anchor.key, 'native-user-id::user');
    assert.equal(request.submittedUserTurnKey, 'native-user-id::user');
  } finally { clearTimeout(timer); }
});

test('native assistant search-unit discovery excludes user, reasoning and outside-turn decoys', async () => {
  const parser = await createAssistantFixtureParser();
  parser.mount(`<main><div data-turn-key="turn-current">
    <div class="group/user-message" data-content-search-unit-key="user-unit" data-chatgpt-search-message-ids="user-id"><p>User text</p></div>
    <div data-testid="cot-v5-status" data-content-search-unit-key="reasoning-unit" data-chatgpt-search-message-ids="reasoning-id"><p>Reasoning text</p></div>
    <div data-content-search-unit-key="assistant-unit" data-chatgpt-search-message-ids="answer-id"><div class="MarkdownRoot-test"><p>Actual answer</p></div></div>
  </div><nav><div data-content-search-unit-key="sidebar-unit" data-chatgpt-search-message-ids="sidebar-id"><p>Sidebar text</p></div></nav></main>`);
  const result = parser.snapshots.readAssistantSnapshot({ submittedUserTurnKey: 'turn-current::user' });
  assert.equal(result.answer, 'Actual answer');
  assert.equal(result.turnKey, 'turn-current::assistant');
});

test('a projected user key absent from the current DOM cannot prove prompt submission', async () => {
  const parser = await createAssistantFixtureParser();
  parser.mount(`<main><div data-turn-key="native-user">
    <div class="group/user-message" data-chatgpt-search-message-ids="native-user"><p>A scheduled wake</p></div>
  </div></main>`);
  const request = {
    requestId: 'request-projection-membership', submittedUserTurnKey: 'projected-user', submittedUserTurnIndex: 0,
    pendingSubmittedTurnExpectedText: 'A scheduled wake',
    update(_type, data) { Object.assign(this, data); },
  };
  const anchor = await parser.snapshots.waitForSubmittedUserTurnAnchor(request, new Set(), { timeoutMs: 20 });
  assert.equal(anchor, null);
  assert.equal(request.submittedUserTurnKey, 'projected-user');
});

test('keyed ChatGPT turns correlate the exact user prompt and assistant branch', async () => {
  const parser = await createAssistantFixtureParser();
  const result = parser.parseRequestWithoutAssistant(`
    <main>
      <div data-turn-key="turn-current">
        <div class="user-branch">
          <div class="group/user-message" data-chatgpt-search-unit-key="user-unit" data-chatgpt-search-message-ids="user-message-id">
            <div data-content-search-unit-key="user-unit"><p>A real submitted prompt</p></div>
          </div>
        </div>
        <div class="assistant-branch">
          <span hidden data-chatgpt-agent-turn-start></span>
          <div data-content-search-unit-key="assistant-unit" data-chatgpt-search-unit-key="assistant-unit" data-chatgpt-search-message-ids="assistant-search-record">
            <div class="MarkdownRoot-test"><p>Correct current answer</p></div>
          </div>
        </div>
      </div>
    </main>
  `, { submittedUserTurnKey: 'turn-current::user' });

  assert.equal(result.userTurnKey, 'turn-current::user');
  assert.equal(result.turnKey, 'turn-current::assistant');
  assert.equal(result.answer, 'Correct current answer');
  assert.deepEqual(
    Array.from(parser.snapshots.getTurnNodes(), parser.snapshots.turnRole),
    ['user', 'assistant'],
  );
});

test('legacy assistant role nodes inside a keyed turn do not duplicate its assistant branch', async () => {
  const parser = await createAssistantFixtureParser();
  parser.mount(`
    <main>
      <div data-turn-key="turn-mixed">
        <div class="user-branch">
          <div class="group/user-message" data-chatgpt-search-unit-key="user-unit" data-chatgpt-search-message-ids="user-message-id">
            <p>Prompt</p>
          </div>
        </div>
        <div class="assistant-branch">
          <span hidden data-chatgpt-agent-turn-start></span>
          <div data-message-author-role="assistant" data-message-id="assistant-message-id">
            <div class="MarkdownRoot-test"><p>One answer</p></div>
          </div>
        </div>
      </div>
    </main>
  `);

  const assistants = parser.snapshots.getTurnNodes().filter((turn) => parser.snapshots.turnRole(turn) === 'assistant');
  assert.equal(assistants.length, 1);
  assert.equal(parser.snapshots.readLatestAssistantSnapshot().answer, 'One answer');
});

test('assistant-turn marker skips a thought-duration control and finds the final Markdown response', async () => {
  const parser = await createAssistantFixtureParser();
  const checkpoint = '{"active_frontier":["frontier"],"ambiguous_send":false,"binding_epoch":1,"continuity":"valid","outstanding":[],"project_id":"example--project","repository":"example/project","schema":"project-governance/planner-runtime-checkpoint-v1","source_identity":"abcdef0","wake_sequence":1}';
  const answer = `The complete Planner response.\n\n[planner-runtime-checkpoint-v1]\n${checkpoint}\n[/planner-runtime-checkpoint-v1]`;
  const result = parser.parseRequestWithoutAssistant(`
    <main>
      <div data-turn-key="turn-current">
        <div class="user-branch">
          <div class="group/user-message" data-chatgpt-search-unit-key="user-unit" data-chatgpt-search-message-ids="user-message-id">
            <div data-content-search-unit-key="user-unit"><p>A real submitted prompt</p></div>
          </div>
        </div>
        <div class="assistant-branch">
          <div class="assistant-header">
            <span hidden data-chatgpt-agent-turn-start></span>
            <button type="button"><span>思考了 13s</span></button>
          </div>
          <div class="MarkdownRoot-test"><p>${answer}</p></div>
        </div>
      </div>
    </main>
  `, { submittedUserTurnKey: 'turn-current::user' });

  assert.equal(result.userTurnKey, 'turn-current::user');
  assert.equal(result.turnKey, 'turn-current::assistant');
  assert.ok(result.answer.includes(answer));
  assert.ok(result.answer.includes(checkpoint));
});

test('assistant-turn marker with only a thought-duration control does not finalize the request', async () => {
  const parser = await createAssistantFixtureParser();
  const result = parser.parseRequestWithoutAssistant(`
    <main>
      <div data-turn-key="turn-current">
        <div class="user-branch">
          <div class="group/user-message" data-chatgpt-search-unit-key="user-unit" data-chatgpt-search-message-ids="user-message-id">
            <div data-content-search-unit-key="user-unit"><p>A real submitted prompt</p></div>
          </div>
        </div>
        <div class="assistant-branch">
          <div class="assistant-header">
            <span hidden data-chatgpt-agent-turn-start></span>
            <button type="button"><span>思考了 13s</span></button>
          </div>
        </div>
      </div>
    </main>
  `, { submittedUserTurnKey: 'turn-current::user' });

  assert.equal(result.answer, '');
  assert.equal(result.format, 'none');
  assert.equal(result.phase, 'ASSISTANT_PLACEHOLDER');
});

test('legacy assistant section with only a thought-duration control stays non-final', async () => {
  const parser = await createAssistantFixtureParser();
  const result = parser.parseRequestWithoutAssistant(`
    <main>
      <section data-turn="user" data-turn-id="legacy-user-turn">
        <div class="rich-text-user-turn">A real submitted prompt</div>
      </section>
      <section data-turn="assistant" data-turn-id="legacy-assistant-turn">
        <div class="assistant-header">
          <span hidden data-chatgpt-agent-turn-start></span>
          <button type="button"><span>思考了 13s</span></button>
        </div>
      </section>
    </main>
  `, { submittedUserTurnKey: 'legacy-user-turn' });

  assert.equal(result.answer, '');
  assert.equal(result.format, 'none');
  assert.equal(result.phase, 'ASSISTANT_PLACEHOLDER');
});

test('canonical assistant message ID does not make a thought-duration control final', async () => {
  const parser = await createAssistantFixtureParser();
  const result = parser.parseRequestWithoutAssistant(`
    <main>
      <section data-turn="user" data-turn-id="legacy-user-turn">
        <div class="rich-text-user-turn">A real submitted prompt</div>
      </section>
      <section data-turn="assistant" data-turn-id="legacy-assistant-turn" data-message-author-role="assistant" data-message-id="assistant-message-id">
        <div class="assistant-header">
          <button type="button"><span>思考了 13s</span></button>
        </div>
      </section>
    </main>
  `, { submittedUserTurnKey: 'legacy-user-turn' });

  assert.equal(result.answer, '');
  assert.equal(result.format, 'none');
  assert.equal(result.phase, 'ASSISTANT_PLACEHOLDER');
});

test('canonical assistant message with a thought control retains a later Markdown response', async () => {
  const parser = await createAssistantFixtureParser();
  const answer = 'The final canonical response body.';
  const result = parser.parseRequestWithoutAssistant(`
    <main>
      <section data-turn="user" data-turn-id="legacy-user-turn">
        <div class="rich-text-user-turn">A real submitted prompt</div>
      </section>
      <section data-turn="assistant" data-turn-id="legacy-assistant-turn" data-message-author-role="assistant" data-message-id="assistant-message-id">
        <div class="assistant-header">
          <span hidden data-chatgpt-agent-turn-start></span>
          <button type="button"><span>思考了 13s</span></button>
        </div>
        <div class="MarkdownRoot-test"><p>${answer}</p></div>
      </section>
    </main>
  `, { submittedUserTurnKey: 'legacy-user-turn' });

  assert.ok(result.answer.includes(answer));
});

test('image-only Markdown response remains a final assistant turn', async () => {
  const parser = await createAssistantFixtureParser();
  const result = parser.parseRequestWithoutAssistant(`
    <main>
      <div data-turn-key="turn-current">
        <div class="user-branch">
          <div class="group/user-message" data-chatgpt-search-unit-key="user-unit" data-chatgpt-search-message-ids="user-message-id">
            <div data-content-search-unit-key="user-unit"><p>A real submitted prompt</p></div>
          </div>
        </div>
        <div class="assistant-branch">
          <span hidden data-chatgpt-agent-turn-start></span>
          <div class="MarkdownRoot-test"><img src="https://example.test/generated.png" alt="generated image"></div>
        </div>
      </div>
    </main>
  `, { submittedUserTurnKey: 'turn-current::user' });

  assert.equal(result.phase, 'ASSISTANT_FINAL');
  assert.notEqual(result.format, 'none');
});
