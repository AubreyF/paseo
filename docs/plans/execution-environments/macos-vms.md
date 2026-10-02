# Disposable macOS test environments

Status: deferred optional project. Not needed for parallel native Freed installations or the first host-execution release.

Introduce macOS VMs only for a concrete test requiring a disposable OS boundary, clean native installation, or independent OS state. Apple Container runs Linux workloads and does not satisfy this use case.

Evaluate available macOS VM tooling, licensing, signing, hardware limits, snapshots, remote interaction, and automation on the actual host. Prior research candidates included Tart and Lume; no selection or installation has been made.

Acceptance: reproducible guest setup, independent credentials/data, bounded resources, reliable teardown, and measurements showing the VM solves the selected test problem. Keep its lifecycle separate from production and do not count a VM as a substitute for fixing Freed's installation identity.
