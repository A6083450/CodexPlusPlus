# DS Style Cost 1.0.0 Acceptance Manifest

This directory documents the fast real-App acceptance evidence for the DS Style Cost rewrite. It is a local acceptance gate only: nothing was published, pushed, tagged, or installed over `/Applications`, and the user's real Codex++ configuration and running apps were never touched.

## Source And Build

- Source commit: `79152fcbad9b0a91cffe67f4a9c49e5e4a3ddd6a` (branch `codex/ds-style-cost-performance` worktree) plus the uncommitted acceptance fixes described below.
- Local test binary: `target/ds-style-cost-test-20260815/codex-plus-plus`
  - SHA-256: `ed0e415cd68c39e752f84d1b2fd5c4dd1e0cf4cf71ff452ecf8640f160292bbd`
  - Built at 10:13 local time, after the last source edit (profile.js at 10:11); identical to `target/release/codex-plus-plus`.
- Isolated configuration root: `XDG_CONFIG_HOME=target/ds-style-cost-test-20260815/config` (Codex++ user scripts and `token-cost-ui.json` only).
- Isolated launcher home: `HOME=target/ds-style-cost-test-20260815/home` (`.codex-session-delete` state, locks, and logs).
- Isolated ChatGPT browser profiles: `target/ds-style-cost-test-20260815/chatgpt-profile-*`.

## Capture Environment (identical to Task 1 baseline)

- Viewport `1440 x 900`, device scale factor `1`, light theme, fixed time `2026-08-15T10:00:00+08:00`, fixed font loading, font gate awaited `document.fonts.ready` plus two animation frames.
- The same eight states as Task 1: HUD idle, HUD running, settings general/profile/usage/pricing, settings calendar, and the local Profile page.
- The capture driver drove the real production dispatcher/event chain; HUD values were never assigned directly.

## Visual Comparison Against Task 1 Baseline

Pixel comparison used `target/ds-style-cost-test-20260815/compare-images.mjs` with the mask manifest `target/ds-style-cost-test-20260815/visual-mask-manifest.json`. Masks cover only data-driven numeric text rectangles (HUD session numbers, usage chart data, pricing row values, calendar day cells) and raster antialiasing of identical text; no entire panel or card is masked.

| Image | Masked changed pixels | Max channel diff | Verdict |
| --- | --- | --- | --- |
| hud-idle.png | 0 | 0 | PASS |
| hud-running.png | 0 | 0 | PASS |
| settings-general.png | 0 | 0 | PASS |
| settings-profile.png | 0 | 0 | PASS |
| settings-usage.png | 1 | 1 | PASS (single-pixel AA) |
| settings-pricing.png | 0 | 0 | PASS |
| settings-calendar.png (settled >300ms reference) | 0 | 0 | PASS |
| profile-page.png | 79 | 17 | PASS (see below) |

- The Task 1 calendar PNG captured the preserved 300 ms Flatpickr open animation at an intermediate frame. Per the task brief, a temporary settled (>300 ms) reference was produced from the frozen 0.8.3 artifact without changing the baseline files; the new settled calendar matches it with zero changed pixels after the 54 data-cell masks. The intermediate-frame comparison (138,670 px, 10.7%) is expected and not a failure.
- profile-page.png has 79 changed pixels (0.0061% of the image, max channel delta 17) scattered across text-line regions within `(14,18)-(1313,254)`. The DOM geometry, font, weight, color, margin, and padding contract matches; this is subpixel raster antialiasing, recorded here as the accepted difference. No mask was applied.
- Removed continuous animations (rolling digits, shimmer) remain the only blanket visual exception.

## Image Inventory

| File | Pixel size | SHA-256 |
| --- | --- | --- |
| `hud-idle.png` | 1440 x 900 | `c958252022512d1360995975427b0d950eac253b4de068fee9e0fe91d315baac` |
| `hud-running.png` | 1440 x 900 | `c958252022512d1360995975427b0d950eac253b4de068fee9e0fe91d315baac` |
| `settings-general.png` | 1440 x 900 | `600e096b3a3eaa70e5609a386c06876c85eb77dbf1bea6b616ea003ee39ca105` |
| `settings-profile.png` | 1440 x 900 | `30857f6d009bb0688ae5ff413ec01fd1188b75ad04cc8040c84d223e1c8c5e5d` |
| `settings-usage.png` | 1440 x 900 | `3bab93a8d94745c861b75957035f5b89e031590e1545edae0929b17dba10d6c5` |
| `settings-pricing.png` | 1440 x 900 | `cbec62816e9aee6a193b4fad941984a0fd093034241ca1487f11d1f35df773cc` |
| `settings-calendar.png` | 1440 x 900 | `d02a645f453505ef48f4979815fa773e4cc8da3a935cb62177f85cbbd6e9237a` |
| `profile-page.png` | 1440 x 900 | `3b95f5f79d45e5dd8c42d25bcdc30c8f8b10887a26d3e3b4f10468c37688ab52` |

`hud-idle.png` and `hud-running.png` are byte-identical, matching the observed 0.8.3 contract documented in the Task 1 baseline manifest (the production event chain produced `running=true/false` and `data-running`, with no visible same-value running state).

## Process Isolation Evidence

- The enabled arm ran on debug port `9339` with launcher PID `23743` and browser PID `22602`; both were terminated by exact PID after measurement, and the port was verified free.
- The user's own Codex++ instance (PIDs `67626`/`67731`, port `9229`) was already closed by the user before this session; nothing user-owned was signaled or mutated. No `pkill`/`killall` or pattern-based termination was used.
- Orphaned ChatGPT crashpad handlers owned by earlier task runs (parent PID 1, crashpad database inside `target/.../chatgpt-profile-*`) were revalidated by exact command line and terminated by exact PID list.
- Raw metrics, traces, temporary scripts, logs, and copied binaries remain under `target/` and are not committed.

## Known Limitations

- The visual comparison and the A/B both used the fixed local fixture (`#codex-task14-local-fixture`, source `final12`) so both arms run the identical deterministic workload; no paid or remote model prompts were sent.
- The enabled-arm renderer was injected once by the launcher at page load (no re-injection), matching production. A host fixture was installed after injection; JavaScript state is unaffected by body replacement.
