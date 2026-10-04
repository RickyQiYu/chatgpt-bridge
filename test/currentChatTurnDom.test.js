import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantFixtureParser } from './helpers/offlineChatDom.js';

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
