# Windows + Chromium: audit and experimental improvements (October 2026)

This branch is a **non-production experiment**. The working Cloudflare Pages site is not
changed by a GitHub commit or workflow run. Do not overwrite the working `Play.js`
and `Play.wasm` until the newly built version has passed smoke tests and you have
backed up those files.

## Scope and evidence

- The original project's `tools/play-web/README.md` and `docs/issues/browser-build.md`
  describe actual performance experiments on **Chrome 155 on a Mac (Apple M5 Pro)**.
  Windows, Edge, and Chrome on Windows were previously listed as **not run**.
- The experimental `safari.patch`, already enabled on `main` in October 2026,
  keeps compiled VU1 programs for reuse; this is the previously observed, high-impact
  fix for spell/explosion slowdowns. We deliberately **did not modify or replace** it.
- The local user's pre-fix measurements were about 6.2 FPS, machine 161 ms/frame,
  video 14 ms/frame, ~4,100 newly translated functions in five seconds.
  After enabling `safari.patch` the user reported that the problem was fixed.
  A numerical after-value has **not** been collected.
- Nothing in the source evidence proves an additional +FPS gain on a Windows desktop.
  Browser cold-start smoke tests cannot measure speed in a real game.

## Changes in this branch

1. **Input polling**: the gamepad selector no longer allocates and filters a temporary
   array on every poll. A 7 ms coalescing window avoids duplicate work when an 8 ms
   timer and `requestAnimationFrame` fire close together. Immediate keyboard and
   touch input event handlers remain in place. The 8 ms periodic timer is preserved
   because the browser can otherwise revert to coarse Windows timer resolution.
2. **Performance report**: `Settings → Performance diagnostics → Save performance
   report…` exports the last 90 one-second measurements plus browser, renderer,
   WebGL thread mode, and picture factor. It **does not** include player names,
   saved-game contents, disc paths, network server URLs or secrets. The matching
   developer console API is `rta.performanceReport()`.
3. **Automated JavaScript tests**: preferred gamepad, handover to a second pad,
   disconnected pads and coalesced polling. The build checks JS syntax too.
4. **Windows Chromium smoke test in CI**: builds WebAssembly under Ubuntu as before,
   downloads that exact artifact on a **Windows runner**, starts the existing local
   server, then uses the installed Google Chrome and Microsoft Edge to check that
   WebAssembly workers initialize and diagnostic controls exist. This is a real
   Windows headless start-up test **without the copyrighted game ISO**.

No changes were made to the game, patches, network protocol, relay security, lobby
server or emulated arithmetic. That avoids changing online determinism.

## Practical Windows/Chromium guidance

- Use a current 64-bit Chrome, Brave or Edge browser. Enable GPU/hardware acceleration;
  inspect `chrome://gpu` or `edge://gpu` if the emulated video thread is slow.
- Play with the tab visible and the browser window in front. Background tabs can be
  throttled, breaking smooth frame pacing and multiplayer sessions.
- In Edge, exclude the Pages URL from **System and performance → Always keep these
  sites active**, and from **Energy saver** if enabled. Microsoft's browser documentation
  specifically recommends these exclusions for games.
- On a laptop, connect it to mains power while playing. Windows Chrome timer granularity
  and device power management can differ on battery; this has **not** been benchmarked
  with this game.
- `machine_ms_per_frame > 16.7` is a CPU/emulator-side slowdown for a 60 fps target;
  `video_ms_per_frame > 16.7` points toward the rendering pipeline. Both values
  are wall-clock measurements, so contention elsewhere in the computer can affect
  them. Use at least 10 seconds of measurements while the game is active.
- One copy of the memory card per browser profile: do not run the same persistent card
  in multiple tabs. Back up saved games from Settings before major upgrades.
- The Cloudflare **Quick Tunnel is temporary**. A change to its address requires
  updating `online.json`. Do not commit private sign-in patches, disc images, or
  local login details to this public repository.

## How to compare builds

1. In the current stable deployment, enter the same location and cast the same spell;
   use `rta.measure(10)` or the diagnostics export. Repeat at least three times.
2. Keep your old `Play.js` and `Play.wasm` backed up.
3. From the experimental GitHub Actions artifact, put only `Play.js` and `Play.wasm`
   into the existing Cloudflare Pages `web` folder (optionally use the new
   `rta-web.js` and `index.html` to get diagnostics). Keep the existing
   `online.json`, `_headers`, `sections.txt` and `*_signin.pnach`.
4. Redeploy and hard-refresh, then measure the same spell at the same picture factor.
5. Compare both FPS *and* `machine_ms_per_frame`, `video_ms_per_frame`,
   `functions_made`, `function_ms_per_frame` and `disc_fetches`.
6. If there is any regression, restore the old files and redeploy.

## Tests that still require a user

- Actual gameplay and high-particle effects on a physical Windows GPU.
- Real gamepad input, keyboard layouts, audio dropouts and fullscreen.
- 2+ separate browser sessions over the production relay and tunnel, with world
  synchronization, disconnects and re-joins.
- Hours-long memory usage, browser freezes, laptop/battery performance.

Sources:
- [Original browser build tests](https://github.com/Open-Champions/champions-return-to-arms-re/blob/main/docs/issues/browser-build.md)
- [Original VU1 cache patch](https://github.com/Open-Champions/champions-return-to-arms-re/blob/main/tools/play-web/safari.patch)
- [Microsoft Edge performance options](https://support.microsoft.com/en-us/edge/learn-about-performance-features-in-microsoft-edge)
- [Chromium Windows timer implementation](https://chromium.googlesource.com/chromium/src/+/HEAD/base/time/time_win.cc)
