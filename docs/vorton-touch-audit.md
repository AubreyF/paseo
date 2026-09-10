# Vorton touch usability audit

September 9, 2026. Scope: sidebar navigation and workspace actions, footer overflow, dropdowns, tooltips, appearance, keyboard focus, viewport height, and existing configuration launch gates.

## Changes

- Detect coarse pointer capability independently of viewport width. A wide iPad must not receive desktop hover interactions merely because its viewport is wide.
- Keep workspace creation and row actions visible on touch devices. Prevent workspace hover cards and tooltip triggers from intercepting the first tap intended for an action.
- Give semantic controls and dropdown triggers minimum 44 CSS pixel targets. Reserve space for trailing actions and increase footer slot spacing, preserving overflow icons.
- Apply a minimum UI base font size of 16 and message font size of 17 on Vorton touch devices. Preserve larger user settings and restore saved sizes when disabled. Input text has a 16 pixel minimum.
- Provide visible keyboard focus and retain pinch zoom. Use dynamic viewport height in Vorton without adding bottom home-indicator space. Vorton removes the legacy Apple web-app capability and translucent status-bar metadata while enabled, retaining the manifest; Paseo restores the original metadata.
- Gate the prior default configuration setting and viewport customization. Existing Vorton preset, compatibility, usage, launch and audio guards remain mode gated.

## Mode contract

Paseo is the default. The selector remains available to enable Vorton. All custom interaction and appearance rules require Vorton; touch enhancements additionally require touch capability. Turning Vorton off restores standard controls and saved appearance. It does not delete credentials, profiles or workspaces, change accounts, or interrupt existing tasks.

Agent instructions in CLAUDE.md, also reached through AGENTS.md, require this contract and publication to the real private instance for every interface request. The same requirements appear in the continuity prompt.

## Verification and limits

27 focused tests passed, covering touch detection and mode cleanup, appearance restoration, tooltip single-click action dispatch, and configuration submission guards. App typecheck and repository lint passed. Browser mode comparison verified that disabling Vorton restores standard model and thinking controls and removes custom preset controls and footer overflow. Re-enabling Vorton restores the selected default configuration.

The browser used for inspection has a fine pointer. Narrow viewport inspection cannot prove physical Safari touch behavior. The coarse-pointer branches are covered by automated tests, but physical iPad and iPhone first-tap navigation, dropdown selection, scrolling, dictation and home-screen viewport behavior still need confirmation after reloading the published interface. No macOS Playwright WebKit was launched.

The September 9 iPhone screenshot still showed a bottom gap after the CSS-only viewport update. That update was deployed but uncommitted. Its tests checked mode cleanup, not screen geometry. The screenshot proportions match the 62 CSS pixel Home Screen window gap reported in [WebKit 301994](https://bugs.webkit.org/show_bug.cgi?id=301994#c12). In that report even `visualViewport.height` is too short, so measuring it cannot recover the missing screen area. Do not treat a passing desktop viewport test as proof this is fixed.

The metadata change addresses the legacy installation configuration implicated by a [matching implementation report](https://github.com/meltface-80/MusicD-Remote/blob/main/CLAUDE.md). It still needs physical iPhone confirmation. Open the private URL in Safari, enable Vorton, then add a new Home Screen shortcut from that loaded page. Keep the old shortcut until the new one is verified; do not clear storage or credentials. An existing shortcut can retain its installation-time window configuration despite new web assets. A Safari tab is the immediate workaround if the installed window remains short.

Inspect the live viewport metadata, not only `public/index.html`: `use-compact-web-viewport-zoom-lock.ts` rewrites it after mount. Its compact zoom lock now excludes Vorton. Focused tests cover metadata removal/restoration and pinch-zoom mode switching; Chromium checks verify the production bundle's final head tags and root height in both modes. These checks do not emulate iOS installation-time window sizing.

Publishing updates only web assets. It does not activate source-only daemon changes or restart running tasks. Follow docs/instance-continuity.md for the tested local and in-container publishing workflows.
