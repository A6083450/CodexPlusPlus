# Conversation View Event-Driven Alignment Design

## Goal

Reduce Codex Renderer and WindowServer work while a task streams output, without changing the centered conversation width, composer position, or HUD alignment.

## Observed Cause

When `codexAppConversationView` is enabled, the renderer injection aligns the conversation and composer every 500 ms. It also schedules alignment for every `ResizeObserver` callback. Streaming output changes element height frequently even though the horizontal geometry used by the alignment algorithm has not changed.

The alignment pass reads layout through `getBoundingClientRect()` and writes width and transform styles. Repeating it for height-only changes causes unnecessary style, layout, paint, and WindowServer composition work.

## Design

Keep the existing width and offset calculations. Change only when alignment is scheduled:

- Remove the unconditional 500 ms polling timer.
- Keep the initial two-frame alignment used after enabling the feature or resolving new target elements.
- Keep `ResizeObserver`, but derive a horizontal geometry signature from each observed entry.
- Schedule one alignment frame only when an observed width changes. Ignore height-only changes from streamed task output.
- Continue using the existing window resize handler and mutation-driven scan to resolve replaced conversation or composer elements.
- Reset cached geometry when the feature is disabled so re-enabling always performs a fresh initial alignment.

The HUD remains independent. Its current composer-width measurement, dimensions, and zero-gap placement are unchanged.

## Failure Handling

If `ResizeObserverEntry` geometry is unavailable, schedule one conservative alignment rather than leaving the interface misaligned. Existing exception isolation in `runScanStep` remains the outer failure boundary.

## Tests

Add focused renderer-injection coverage proving:

- the conversation view runtime contains no interval-based polling;
- equal-width resize entries do not schedule another alignment;
- a width change schedules exactly one alignment;
- height-only changes do not schedule alignment;
- cleanup clears the remembered horizontal geometry;
- the existing initial and resize frame budgets and offset calculations remain unchanged.

Run the focused frontend renderer tests and Rust CDP bridge tests. Then hot-load the updated injection into the current Codex window and compare an active-task sample for layout counts, Renderer CPU, GPU service CPU, WindowServer CPU, and AGX utilization.

## Out Of Scope

- Changing HUD layout or visual styling.
- Disabling GPU acceleration.
- Hiding task progress or streaming output.
- Refactoring the per-session action menus; their retained nodes and listeners are a separate static-memory optimization.
