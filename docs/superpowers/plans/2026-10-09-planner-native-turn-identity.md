# Planner Native Turn Identity Recovery Plan

**Goal:** Read the exact submitted Planner turn after optimistic ChatGPT identities settle and select its final assistant message when user and thought controls share a parent.

**Architecture:** The current-turn DOM adapter rejects the observed temporary `pending-chatgpt-submit` key. It discovers final assistant messages from their native content-search/message-id attributes, keeping user, reasoning and control nodes outside the response. Submission waits for a currently present matching user record rather than trusting a stale projected key. Existing exact prompt, request, conversation and lease evidence remains mandatory.

- [x] Add executable sanitized shared-parent and optimistic-key regressions and observe them fail.
- [x] Correct currentTurnDom discovery/identity and verify current DOM membership before accepting an already-captured submission anchor.
- [x] Preserve anonymous, sidebar, reasoning, future-user and thought-only rejection coverage.
- [x] Close review findings with bounded progress scope, preserved owned artifact branches and current-DOM prompt/steer reconciliation; cover READY/GENERATING and excluded user/future artifacts.
- [x] Verify the native final-answer/progress split and preserve uncertainty for prior-submission, read-failure and production-shaped hash-only recovery.
- [x] Keep composer-only recovery uncertain even when the projected key is empty; a matching newly submitted DOM user cannot become no-send evidence.
- [x] Update compatible patch versions and source handoff; run focused parser/admission/recovery tests, full suite and package/quality checks.
- [ ] Review and publish the focused source change, deploy the stable extension and reconcile terminal old wake records from exact evidence.
- [ ] Preserve the two canonical browser tabs across the operator turn and verify natural wake completion plus checkpoint readback for both.
