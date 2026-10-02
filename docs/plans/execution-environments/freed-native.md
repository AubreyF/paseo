# Parallel native Freed installations

Status: future project owned by the separate Freed repository. No macOS VM prerequisite.

Define one installation ID before native library initialization. Use it consistently for app identity, library and vault storage, Keychain services, locks, logs, snapshots, WebKit state, and collector paths. Refuse mismatched identities rather than opening another installation's data.

The diagnostic review found that changing only a Tauri bundle ID does not isolate the pre-Tauri library, fixed preview credential namespace, or inherited updater behavior. Disable actual updater checks/install for experimental builds or use a separate signed channel; disabling artifact generation is insufficient.

Begin with synthetic data and providers/cloud sync disabled. Never copy production credentials or a live database into an experiment as setup. Allocate concurrent service ports explicitly. Attribute collector metrics to the instance or label machine-wide metrics as shared.

Acceptance: two experiments plus production can coexist without sharing data, credentials, locks, update targets, or collector pointers. Stop and remove one without changing the others. Verify source/build provenance and recovery independently.

Independent of container orchestration and credential brokering. Preserve the detailed installation findings privately; implement and estimate this work in Freed, not Vorteo.
