# Kernel information-flow research

Status: speculative research, no implementation commitment.

Evaluate whether kernel-level provenance or taint tracking would enforce a concrete requirement that environment isolation, typed operations, and explicit approvals cannot satisfy. Define the adversary, channels, platform support, expected false positives, and performance budget first.

Deliver a small experiment and a decision to adopt or reject, not a new mandatory substrate. Consider filesystem, IPC, networking, clipboard, browser, and human-mediated channels; do not claim comprehensive exfiltration prevention from partial tracking.

Independent of all delivery milestones. No engineering estimate until a bounded problem and supported platform are chosen.
