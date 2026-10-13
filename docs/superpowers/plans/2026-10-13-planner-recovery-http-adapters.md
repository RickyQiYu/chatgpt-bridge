# Planner Recovery HTTP Adapters Implementation Plan

**Goal:** Provide stable, bounded exact-client observation-refresh and exact-request cancellation HTTP contracts for Governance recovery.

**Architecture:** Reuse the typed Protocol 5 command registry and existing request lifecycle/effect machinery. Refresh reads back only the explicit client's newly revisioned observation; cancel succeeds only after confirmed request-scoped `prompt.cancel`. Keep `/browser/tabs/reload` unchanged.

- [x] Add failing coordinator and HTTP regressions for exact identity, fresh readback, cancellation outcome, and bounded output.
- [x] Correlate `tab.observation.refreshed` with its registered result command and expose exact-client refresh through existing admission/coordinator layers.
- [x] Return the existing canonical cancellation's terminal command result and expose a source-checked request-cancel method without using global stop.
- [x] Add narrow HTTP routes, static typed error mapping, allowlisted observation projection, and API contract documentation.
- [x] Update local handoff and engineering-goal records; run focused and full validation, inspect diff, and commit locally on detached HEAD.
