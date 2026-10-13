# Planner Recovery HTTP Adapters

Status: Approved by immutable work order 2026-10-13T14:33:00Z

## Problem

Governance recovery needs stable public HTTP operations for exact-client tab
observation refresh and exact-request prompt cancellation. The existing typed
Protocol 5 commands are internal transport contracts; a consumer should not
need to construct their websocket envelopes. Reload already has an exact-client
route and remains the sole public reload operation.

## Design

Add two purpose-built HTTP routes. Observation refresh requires a
`sourceClientId`, dispatches `tab.observation.refresh` through the canonical
command registry, then reads the same connected client and proves its
observation revision and timestamp both advanced and remain fresh. The response
is an allowlisted projection of UI/runtime state; it excludes page text,
prompts, output, session IDs, lease identity, tokens, and command internals.

Request cancellation requires both `requestId` and `sourceClientId`. The
canonical tracked request and source ownership are checked before the existing
request cancellation coordinator creates its immutable `prompt.cancel`
BrowserEffect. HTTP success requires the exact effect's terminal success and
canonical cancelled state. Missing, terminal, source-mismatched, failed, or
uncertain outcomes return bounded typed errors. No route uses global stop.

`POST /browser/tabs/reload` remains unchanged and authoritative. API-token
middleware remains inherited from the existing router.

## Considered approaches

- A generic arbitrary-command endpoint is rejected because it exposes a wider
  transport surface and weakens stable validation.
- A new reload endpoint is rejected because the existing exact-client reload
  route already owns that contract.
- The selected approach adds only observation-refresh and request-cancel
  adapters and keeps lifecycle/effect ownership in existing coordinators.

## Verification

Deterministic tests will cover exact source routing, freshness/readback failure,
bounded response projection, missing/unknown/terminal/mismatched request
identity, canonical effect identity, and unconfirmed cancellation. Existing
reload and route authentication contracts remain covered.
