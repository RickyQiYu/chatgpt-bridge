# Stale Planner Wake Read Command Release Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow an exact stale lease release to proceed when the only outstanding request child is a read-only effect-evidence command, while preserving all physical effect, download, and write-command blockers.

**Architecture:** `activeRequestChildren()` will classify a persisted command as non-physical only when its registered contract says `operation: read` and `reconcilePolicy: effect_evidence`. The existing Bridge stale-release coordinator still requires exact lease identity, canonical terminal state, no active server request, and a fresh idle observation; the extension remains the sole owner of physical release. Active effects, downloads, and all other request commands continue to block.

**Tech Stack:** Node.js 20+, JavaScript ES modules, Chrome Manifest V3, Protocol 5, `node:test`.

---

### Task 1: Specify the read-only child regression

**Files:**
- Modify: `test/commandReleaseAndReloadRegression.test.js`

- [x] **Step 1: Add a test that persists a dispatched read-only evidence command**

Add this test to `test/commandReleaseAndReloadRegression.test.js`:

```js
test('lease release recovery ignores a typed read-only effect evidence command', async () => {
  const request = { requestId: 'request-read-reconcile', leaseId: 'lease-read-reconcile', ownerServerInstanceId: 'server-regression', responseEpoch: 0 };
  const h = backgroundHarness(104);
  try {
    await initializeHarness(h);
    await h.backgroundState.transition(h.state.tabId, { type: 'lease.claim', ...request, contentEpoch: h.state.contentEpoch });
    const commandId = 'read-effect-reconcile';
    const registered = await h.backgroundState.transition(h.state.tabId, {
      type: 'command.registered', ...request, scope: 'request', commandId,
      commandType: 'request.effect.reconcile', mode: 'result', operation: 'read',
      retryPolicy: 'always', reconcilePolicy: 'effect_evidence', contentEpoch: h.state.contentEpoch,
    });
    assert.equal(registered.accepted, true, registered.reason);
    const acceptedEnvelope = h.createEnvelopeDraft(h.state, ExtensionMessageType.COMMAND_ACCEPTED, {
      commandId, commandType: 'request.effect.reconcile', requestId: request.requestId,
      commandScope: 'request', commandMode: 'result',
    }, { commandId, causationId: `message-${commandId}`, lease: request });
    const dispatched = await h.backgroundState.transition(h.state.tabId, {
      type: 'command.dispatched', commandId, acceptedEnvelope, ...request, contentEpoch: h.state.contentEpoch,
    });
    assert.equal(dispatched.accepted, true, dispatched.reason);

    const recovered = await h.backgroundState.transition(h.state.tabId, releaseRecoveryEvent(h, request, 'release-after-read-command'));
    assert.equal(recovered.accepted, true, recovered.reason);
    assert.equal(recovered.state.lease.status, 'releasing');
    const released = await h.backgroundState.transition(h.state.tabId, {
      type: 'lease.release', ...request, contentEpoch: h.state.contentEpoch,
    });
    assert.equal(released.accepted, true, released.reason);
    assert.equal(released.state.lease, null);
    assert.equal(released.state.commands[commandId].status, 'dispatched');
    assert.deepEqual(released.state.effects, {});
    assert.deepEqual(released.state.downloads, {});
  } finally { h.restore(); }
});
```

- [x] **Step 2: Add a fail-closed control case**

Repeat the setup with `operation: 'read'` plus `reconcilePolicy: 'request_projection'`, then with `reconcilePolicy: 'effect_evidence'` but no `operation`. Both recoveries must remain rejected with `lease_children_active`; neither field alone makes a command non-physical.

- [x] **Step 3: Run the focused tests and confirm the new valid-read case fails**

Before running tests in this worktree, run `npm ci` to materialize the exact lockfile dependencies.

Run:

```bash
node --test test/commandReleaseAndReloadRegression.test.js
```

Expected red failure: a correctly typed read-only reconciliation command is counted as an active child. Existing prompt-send, physical-effect, download, identity, and one-shot release tests remain green.

### Task 2: Exclude only typed read-only evidence commands from the physical-child gate

**Files:**
- Modify: `tools/chrome-bridge-extension/background/stateV6Core.js`
- Test: `test/commandReleaseAndReloadRegression.test.js`

- [x] **Step 1: Update the active-command predicate**

Keep request identity and active status checks. Exclude a command from `activeRequestChildren().commands` only when both `command.operation === 'read'` and `command.reconcilePolicy === 'effect_evidence'`. Do not infer read-only behavior from the command name alone.

The predicate is:

```js
const readOnlyEffectEvidence = command.operation === 'read'
  && command.reconcilePolicy === 'effect_evidence';
return !readOnlyEffectEvidence;
```

- [x] **Step 2: Run focused regression tests**

Run:

```bash
node --test test/commandReleaseAndReloadRegression.test.js
```

Expected: typed read-only reconciliation no longer blocks; missing metadata and every existing physical-child case still block.

### Task 3: Record release semantics and compatible source versions

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tools/chrome-bridge-extension/manifest.json`
- Modify: `tools/chrome-bridge-extension/content.js`
- Modify: `src/extensionCompatibility.js`
- Modify: `test/extensionCompatibility.test.js`
- Modify: `CONTEXT.MD`
- Modify: `ARCHITECTURE.md`
- Modify: `SESSION.MD`

- [x] **Step 1: Bump compatible patch versions together**

Set Bridge to `6.4.15`, extension to `2.4.18`, and content runtime to `4.4.18`; update the minimum/recommended compatibility values and their assertions.

- [x] **Step 2: Update durable source and handoff documentation**

Document that only a command explicitly persisted as `read` plus `effect_evidence` is non-physical for stale release. Keep the canonical terminal-state, fresh idle observation, exact identity, active-effect, active-download, and all-other-command gates unchanged. Record the source as an undeployed candidate until activation is verified, then update the current session handoff with exact live rollout evidence.

- [x] **Step 3: Run release validation**

Run:

```bash
node --test test/commandReleaseAndReloadRegression.test.js test/backgroundFaultInjectionMatrix.test.js test/extensionCompatibility.test.js
npm test
npm run check
npm run check:quality
git diff --check
```

Expected: all focused and full tests pass; package/syntax checks pass; quality exits 0; diff check is clean.

### Task 4: Deliver the source candidate and verify the local wake path

- [x] Review the final diff for unrelated changes and sensitive data.
- [x] Commit the candidate on this isolated branch.
- [x] Fast-forward the existing `fix/stale-lease-release-command-reconciliation-20261006` branch from the `runtime-main` worktree to this tested head and push that branch, updating PR #14 without merging it.
- [x] Install/verify the stable extension bundle in Chrome, reload it, refresh both canonical tabs, and restart the Bridge canary; both clients report compatible versions.
- [x] Observe natural due wake delivery for Governance 157 and Voice Terminal 179; Bridge confirms both corresponding turns completed.
- [ ] Resolve active requests 158/180 from exact turn/effect evidence. Both are submitted with `submitted_user_turn_not_found`, zero answer length, and no assistant turn key; do not replay, cancel, or clear them. Inspect the DOM turn boundary read-only after the Mac UI is accessible.
- [ ] After 158/180 have protocol-defined terminal outcomes, verify complete checkpoint footer readbacks and `ambiguous_send` values on the next natural cadence. The 157/179 replies did not produce complete footers, so cached checkpoint sequences remain 156/178.
- [x] Do not merge the PR or alter host-execution Issues #633/#637.
