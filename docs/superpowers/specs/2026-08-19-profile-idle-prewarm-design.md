# Profile Idle Prewarm Design

## Context

The Profile unlock path was changed in `13e5697` so startup installs only a
small `pointerdown` demand listener. The first Profile interaction then
installs the full unlock path, including prototype wrappers, Electron bridge
hooks, message listeners, asynchronous module discovery, and a Profile DOM
observer. This protects Renderer startup and idle performance, but it makes the
first Profile interaction pay the local ledger and preferences read cost.

The requested behavior is to prepare local Profile data automatically without
opening the Profile page, while preserving the Renderer performance protection.

## Goals

- Load the local Profile ledger and preferences automatically after the first
  useful render work has settled.
- Keep the new work off the synchronous startup path.
- Run the prewarm at most once per userscript lifetime.
- Avoid additional network requests, polling, global prototype patches,
  Electron bridge hooks, message interception, and broad DOM observers during
  prewarm.
- Preserve the existing full unlock path for the first real Profile
  interaction.
- Cancel pending prewarm work when the userscript is destroyed or Profile
  unlock is disabled.

## Non-goals

- Do not open or navigate to the Profile page automatically.
- Do not install the full Profile unlock path before Profile interaction.
- Do not change the local Profile data format, ledger schema, or persistence
  behavior.
- Do not add a worker, timer loop, network prefetch, or new bridge protocol.

## Design

Add a one-shot `scheduleProfilePrewarm` path next to the existing Profile
unlock lifecycle. Use a fixed `PROFILE_PREWARM_IDLE_TIMEOUT_MS = 2000` bound
so the fallback cannot be mistaken for a polling loop.

1. `start()` continues to load the existing local usage ledger and install the
   normal capture path. It then schedules the Profile prewarm without doing the
   new ledger work inline.
2. When available, use `requestIdleCallback` with a bounded timeout. Use one
   `setTimeout` fallback for runtimes without `requestIdleCallback`.
3. The callback checks `profileUnlockEnabled()`, calls
   `ensureProfileLedgerLoaded()` and `localProfilePrefs()`, then clears its
   scheduling handles. These operations load existing local state only; they
   do not install `installOfficialProfileUnlock()`.
4. Store the idle callback/timer handles and a scheduled flag in `state`, so
   duplicate scheduling is impossible and `destroy()` can cancel pending work.
5. Disabling Profile unlock cancels pending prewarm work and resets the
   scheduled flag. Re-enabling it can schedule one new prewarm for that enabled
   period, while the existing interaction-driven full unlock remains unchanged.

The prewarm is intentionally small: it moves deterministic local I/O and
ledger normalization into browser idle time, but does not turn the global
Renderer hot path on. The first Profile interaction still owns the expensive
hooks because those hooks are only needed when Profile UI behavior is actually
used.

## Error Handling

Prewarm failures are best-effort and must not interrupt startup, rendering, or
the existing Profile click path. Existing local storage and IndexedDB helpers
remain responsible for their own fallback behavior. The scheduler clears its
handles before running so a failure cannot create a retry loop.

## Testing

Extend the existing userscript source-contract tests with a regression that
requires:

- the idle timeout constant and `scheduleProfilePrewarm` function;
- an idle callback plus a bounded timeout fallback;
- calls to `ensureProfileLedgerLoaded()` and `localProfilePrefs()` from the
  prewarm callback;
- startup scheduling of the prewarm;
- no eager `installOfficialProfileUnlock()` call in startup;
- cancellation support in the destroy/disable lifecycle.

Run the focused source-contract test, the full manager test suite, and the
TypeScript check. Before packaging, inspect the diff and run the existing
macOS build/DMG validation flow separately.

## Alternatives Considered

### Install the full unlock path during startup idle time

This removes the first-click activation delay, but permanently enables global
wrappers and observers even when Profile is never used. It conflicts with the
Renderer performance requirement and is rejected.

### Detect Profile UI visibility and install the full path then

This avoids startup work but still creates broad hooks as soon as Profile UI is
present, and it adds another observer or polling path. It is less predictable
than the existing click gate and is rejected for this change.
