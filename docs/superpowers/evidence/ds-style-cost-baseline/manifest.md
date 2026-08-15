# DS Style Cost 0.8.3 Visual Baseline

This directory freezes the observable visual contract of the checked-in DS Style Cost user script before its replacement.

## Source And Capture Environment

- Source commit: `91bccf429176424655f5bfdc2e37761f66cb3e2a`
- Script version observed after execution: `0.8.3`
- Checked-in and isolated installed script SHA-256: `e7d98c9b12886b759de385a7da6146898fbc80f7ce7fa2d0c9b6d6d003615dab`
- App binary: release `codex-plus-plus` copied to `target/ds-style-cost-baseline-20260815/codex-plus-plus`
- Configuration root: isolated `target/ds-style-cost-baseline-20260815/config`
- Renderer: a separate ChatGPT process opened with debug port `9338` and an isolated profile under the task target directory
- Capture API: Chrome DevTools Protocol `Page.captureScreenshot`
- Viewport: `1440 x 900`
- Device scale factor: `1`
- Theme: light
- Fixed time: `2026-08-15T10:00:00+08:00`
- Font gate: each capture awaited `document.fonts.ready` and two animation frames

The capture driver executed the installed isolated copy of the old script against controlled composer, settings, account-menu, and profile-page fixtures. It did not read or mutate the user's real Codex++ configuration or ChatGPT profile.

## Fixed Fixture

HUD values were fixed to `12` turns, `34` steps, LLM duration `1m 08s`, tool-call duration `24s`, first-token average `1.2s`, output rate `52 tok/s`, cache hit `72%`, input `128K`, and output `18K`.

Profile identity was fixed to `Local Usage`, `@local-usage`, `local@example.com`, and `Pro 20x`. Usage analytics used 12 deterministic local turns at the fixed date and two model names.

## Measured Bounds

Coordinates are CSS pixels in the fixed viewport.

| Surface | Selector | Bounds `(x, y, width, height)` |
| --- | --- | --- |
| HUD | `#codex-live-token-cost` | `(294, 116, 1100, 61)` |
| Settings modal | `.cltc-settings-modal` | `(260, 140, 920, 620)` |
| Profile card | `#profile-page .profile-card` | `(374, 205, 940, 271)` |

## Image Inventory

| File | Pixel size | SHA-256 |
| --- | --- | --- |
| `hud-idle.png` | `1440 x 900` | `1e51dd50e50841b953135cd2615752fe03e4428b1eaf71fafcceccdfe45cd53a` |
| `hud-running.png` | `1440 x 900` | `1e51dd50e50841b953135cd2615752fe03e4428b1eaf71fafcceccdfe45cd53a` |
| `profile-page.png` | `1440 x 900` | `b48a2d3e7dfbff02690627c0b06be795cb9a0c168f31084cf460cbd3085ec458` |
| `settings-calendar.png` | `1440 x 900` | `f1bd82df7ec99115d8816918fb08d5b2d74ff2c1f5de7b6e54fb6f21636f7e36` |
| `settings-general.png` | `1440 x 900` | `93b095f452c4387232525501d32c8a8eb1d0d6bf87a623dc8f4e2ecb26cfd778` |
| `settings-pricing.png` | `1440 x 900` | `63c34516224af0a5ac522b56eb4a8caba9ee6be7c30b23d37578f8122b1c418c` |
| `settings-profile.png` | `1440 x 900` | `bf413fad6fcb990f4335b055a25181c116cdb67bd2efdb48895899ff63b25e67` |
| `settings-usage.png` | `1440 x 900` | `757e09dc251b94108659321a07da641de5ee1a0cbd3832d5ef46b5f7ca81a0d8` |

`hud-idle.png` and `hud-running.png` are byte-identical because the deterministic capture suppresses the old continuous shimmer and rolling-digit motion. The running fixture still sets the old HUD's observable running state before capture.

## Accepted Visual Differences

The only accepted visual differences when comparing a replacement against these baselines are removed rolling digits, removed shimmer, and removed or timing-shifted continuous animations. Layout, text, colors, spacing, radii, controls, and static interaction states are not accepted differences.
