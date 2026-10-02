# Browser credential delegation

Status: deferred research project.

Define how a task can request a specific browser-authenticated operation without receiving a reusable signed-in profile, cookies, or unrestricted session control. Start with one named workflow and explicit owner approval rather than a universal logged-in browser.

Separate credential possession, browser control, and external operation authority. Test redirects, cross-origin navigation, downloads, profile recovery, and approval retargeting. Keep protected owner sessions inaccessible to guest automation.

Acceptance: demonstrate a bounded operation and prove the guest cannot reuse the session outside that operation. Depends on browser trust separation and broker grants for implementation. Independent research is possible using synthetic accounts; no production login migration is included.
