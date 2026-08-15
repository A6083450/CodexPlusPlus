# DS Style Cost 0.8.3 Visual Baseline

This directory freezes the observable visual contract of the checked-in DS Style Cost user script before its replacement.

## Source And Capture Environment

- Source commit: `91bccf429176424655f5bfdc2e37761f66cb3e2a`
- Script version observed after execution: `0.8.3`
- Checked-in and isolated installed script SHA-256: `e7d98c9b12886b759de385a7da6146898fbc80f7ce7fa2d0c9b6d6d003615dab`
- App binary: release `codex-plus-plus` copied to `target/ds-style-cost-baseline-20260815/codex-plus-plus`
- Configuration root: isolated `target/ds-style-cost-baseline-20260815/config`
- Renderer: a separate ChatGPT process opened with debug port `9338` and isolated profile `target/ds-style-cost-baseline-20260815/chatgpt-profile-fix-round1`
- Capture API: Chrome DevTools Protocol `Page.captureScreenshot`
- Viewport: `1440 x 900`
- Device scale factor: `1`
- Theme: light
- Fixed time: `2026-08-15T10:00:00+08:00`
- Font gate: each capture awaited `document.fonts.ready` and two animation frames

The capture driver executed the installed isolated copy of the old script against controlled composer, settings, account-menu, and profile-page fixtures. It did not read or mutate the user's real Codex++ configuration or ChatGPT profile. It imported 11 completed turns through `importLocalUsageTurns`, then dispatched real `message` events for `turn/started`, `thread/tokenUsage/updated`, `item/agentMessage/delta`, and `turn/completed`. The installed script produced the twelfth turn and both running states; the driver never assigned HUD value slots, `data-running`, or animation classes.

## Fixed Fixture

HUD values were fixed to `12` turns, `34` steps, LLM duration `68s` (rendered `1m8s`), tool-call duration `24s`, first-token average `1.2s`, output rate `52 tok/s`, cache hit `72%`, input `128K`, and output `18K`. The capture driver asserted these rendered values before both HUD captures and again after every settings-panel or calendar re-render.

Profile identity was fixed to `Local Usage`, `@local-usage`, `local@example.com`, and `Pro 20x`. Usage analytics used 12 deterministic local turns at the fixed date and two model names.

## Measured Bounds

Coordinates are CSS pixels in the fixed viewport.

| Surface | Selector | Bounds `(x, y, width, height)` |
| --- | --- | --- |
| HUD | `#codex-live-token-cost` | `(294, 116, 1100, 61)` |
| Settings modal | `.cltc-settings-modal` | `(260, 140, 920, 620)` |
| Profile card | `#profile-page .profile-card` | `(374, 205, 940, 271)` |
| Account trigger avatar | `#profile-trigger [data-cltc-profile-identity-avatar]` | `(22, 854, 16, 16)` |
| Account menu avatar | `#profile-menu .size-8` | `(31, 739, 32, 32)` |

The avatar bounds were measured after opening the account menu in the real renderer. The `16px` trigger geometry comes from the script-generated `icon-sm` class resolved by the host fixture CSS; the retained host menu avatar resolves to `32px`.

## Computed Style

The real renderer returned these light-theme custom properties from `getComputedStyle(#codex-live-token-cost)`:

| Property | Value |
| --- | --- |
| `--cltc-text` | `#111827` |
| `--cltc-muted` | `rgba(26, 28, 31, .494)` |
| `--cltc-border` | `#d1d5db` |
| `--cltc-surface` | `#ffffff` |
| `--cltc-arc-bg` | `rgb(246, 246, 246)` |
| `--cltc-arc-radius` | `20px` |

## Image Inventory

| File | Pixel size | SHA-256 |
| --- | --- | --- |
| `hud-idle.png` | `1440 x 900` | `bf36885a7b502f3555dd653861c5997ce79cdbdd790328ef40dd850fb28840fc` |
| `hud-running.png` | `1440 x 900` | `bf36885a7b502f3555dd653861c5997ce79cdbdd790328ef40dd850fb28840fc` |
| `profile-page.png` | `1440 x 900` | `507ca262fc7066a5b9b3f48ced95fb020cd9d46acef9ec1dba33d8436bba3a98` |
| `settings-calendar.png` | `1440 x 900` | `fb387ae20493f566c64946f0862ec12fe514c8f612d1a66f421e3de9e50704cf` |
| `settings-general.png` | `1440 x 900` | `1fb762abf9cae06a28b9dab3c8bc9b1d1382f62a499cb2bab67e05cd17fad941` |
| `settings-pricing.png` | `1440 x 900` | `2d828c09fdf0e72d588b945e90534629694de4672d10ac1ad6c8516edd3726ec` |
| `settings-profile.png` | `1440 x 900` | `54232737ae184c358d57eed24106066a1294463b22c7bee012e055f4ae55bb1e` |
| `settings-usage.png` | `1440 x 900` | `f25f88e353e17257784e1440c61bdc64f9f7548654a2c088acaccef6db79569a` |

`hud-idle.png` and `hud-running.png` are byte-identical because version 0.8.3 has no visible same-value running state. The production event chain produced `liveSnapshot().running === true` and root `data-running="true"` for the running capture, then `false`/`"false"` after completion. Even with reduced motion disabled, the executed HUD contained zero `.cltc-cadenced-shimmer` nodes: the old shimmer markup helpers are not used, and its rolling digits have no effective from-position phase. Pixel equality is therefore an observed 0.8.3 contract, not capture-driver animation suppression.

## Accepted Visual Differences

The only accepted visual differences when comparing a replacement against these baselines are removed rolling digits, removed shimmer, and removed or timing-shifted continuous animations. Layout, text, colors, spacing, radii, controls, and static interaction states are not accepted differences.
