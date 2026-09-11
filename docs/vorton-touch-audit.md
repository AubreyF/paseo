# Vorton touch usability audit

September 10, 2026. Scope: sidebar navigation and workspace actions, footer overflow, dropdowns, tooltips, appearance, keyboard focus, viewport height, and existing configuration launch gates.

## Changes

- Detect coarse pointer capability independently of viewport width. A wide iPad must not receive desktop hover interactions merely because its viewport is wide.
- Keep workspace creation and row actions visible on touch devices. Prevent workspace hover cards and tooltip triggers from intercepting the first tap intended for an action.
- Give semantic controls and dropdown triggers minimum 44 CSS pixel targets. Reserve space for trailing actions and increase footer slot spacing, preserving overflow icons.
- Apply a minimum UI base font size of 16 and message font size of 17 on Vorton touch devices. Preserve larger user settings and restore saved sizes when disabled. Input text has a 16 pixel minimum.
- Provide visible keyboard focus and retain pinch zoom. Use dynamic viewport height in browser tabs and the large viewport in standalone mode. Preserve Apple installation metadata; runtime removal did not establish a fix for the reported iPhone gap.
- Keep informational tooltips tappable. Touch pointer exit must not immediately dismiss them. Action tooltips remain bypassed so navigation takes one tap.
- Keep composer preset and permission selectors on one row, centered between the other mobile controls and left-aligned on desktop. Center the permission caption inside its 44 pixel hit target. Abbreviate captions only when measured content exceeds available width; retain full menu and accessibility labels.
- Separate dictation from submit with a 44 pixel outlined microphone at the top right of the message field. The recording panel fills the existing composer footprint; edit occupies the microphone position, cancel stays bottom left, and submit stays bottom right. Keep its passive volume display out of button hit testing. Hide the desktop focus hint on touch devices; the browser does not provide reliable hardware-keyboard presence detection.
- On compact Vorton touch layouts, separate messaging from the conversation with a full-width top rule. The idle input has no visible outline, rounded container, or contrasting background. Keep the green recording state and desktop/Paseo surfaces.
- Gate the prior default configuration setting and viewport customization. Existing Vorton preset, compatibility, usage, launch and audio guards remain mode gated.

## Mode contract

Paseo is the default. The selector remains available to enable Vorton. All custom interaction and appearance rules require Vorton; touch enhancements additionally require touch capability. Turning Vorton off restores standard controls and saved appearance. It does not delete credentials, profiles or workspaces, change accounts, or interrupt existing tasks.

Agent instructions in CLAUDE.md, also reached through AGENTS.md, require this contract and publication to the real private instance for every interface request. The same requirements appear in the continuity prompt.

## Verification and limits

The September 10 composer and recording changes passed 23 focused tests for tooltip interaction, permission captions, metadata preservation, and independent recording actions. Workspace typechecks and focused lint passed. Repository lint still reports unrelated errors in pending persistence and workspace-title work.

Chromium touch emulation checked 320, 375, 402, and 430 pixel phone widths, landscape/portrait transitions, and wide-screen Vorton off/on behavior. Preset and permission controls stay on one row; abbreviations expand when space returns. Dictation and submit have separate 44 pixel targets. Synthetic microphone recording preserved both 120 and 217 pixel composer heights, matched edit/submit coordinates exactly, and preserved the draft after cancellation. Paseo retained its original 75 pixel recording panel. A real context meter opens its details by tapping and dismisses on a second tap. Physical iPhone and iPad dictation, keyboard, pinch zoom, and Home Screen viewport acceptance remain device checks. No macOS Playwright WebKit was launched.

The September 9 iPhone screenshot still showed a bottom gap after the CSS-only viewport update. That update was deployed but uncommitted. Its tests checked mode cleanup, not screen geometry. The screenshot proportions match the 62 CSS pixel Home Screen window gap reported in [WebKit 301994](https://bugs.webkit.org/show_bug.cgi?id=301994#c12). In that report even `visualViewport.height` is too short, so measuring it cannot recover the missing screen area. Do not treat a passing desktop viewport test as proof this is fixed.

The iPhone 17 Pro report includes iOS 27 and a gap that changes after rotation. The revised standalone rule uses `100vh` rather than `100dvh`, following the viewport-unit distinction reported in [WebKit 254868](https://bugs.webkit.org/show_bug.cgi?id=254868). This does not prove that iOS exposes the full compositor surface. App diagnostics in Vorton include startup/recent viewport measurements, safe-area insets, root dimensions, and the loaded entry script. Use those measurements to distinguish a short document from a short system window. Do not require shortcut reinstallation or claim physical-device acceptance from Chromium results.

The later composer screenshot exposed another gap: the chat wrapper added the bottom safe-area inset outside the field, in addition to the composer's margin. On compact Vorton touch layouts, the composer owns that clearance inside its background. The September 11 adjustment matches the bottom and side margins at 16 pixels and counts that margin toward home-gesture clearance. Safe-area insets describe an unobstructed rectangle, not the physical display's corner radius; do not infer device curvature from them. Keep top and bottom padding explicit: Unistyles expands `paddingVertical` after a dynamic `paddingBottom` override and can restore the old value. Browser verification must supply nonzero safe-area insets, check control clearance, and compare recording positions as well as the field boundary.

Inspect the live viewport metadata, not only `public/index.html`: `use-compact-web-viewport-zoom-lock.ts` rewrites it after mount. Its compact zoom lock excludes Vorton. Verify the loaded entry script against the published release when investigating stale code. Closing an app does not clear its persistent caches.

Publishing updates only web assets. It does not activate source-only daemon changes or restart running tasks. Follow docs/instance-continuity.md for the tested local and in-container publishing workflows.
