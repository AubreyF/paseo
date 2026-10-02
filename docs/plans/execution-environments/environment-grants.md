# Environment identities and task grants

Status: future project. This adds selective authority beyond the trusted-host first release.

Mint environment identities and generations on the host. Bind narrowly typed operations to an environment, workspace, task, expiry, and reviewed request revision. Guest-supplied names, paths, or agent IDs are not proof of authority. Keep owner approvals and grant state outside guest storage.

Arbitrary code in one guest can steal other credentials accessible in that guest. Treat the environment as the isolation principal. Separate mutually hostile agents into different environments rather than pretending per-agent bearer tokens solve this.

Reuse existing semantic daemon permissions where applicable, but do not advertise workspace confinement before every affected file, execution, observation, and lifecycle path enforces it. Avoid a general shell or unrestricted URL operation disguised as a grant.

Acceptance: replay and stale-generation rejection, scope enforcement, revocation before dispatch, approval-payload integrity, and denial of guest-created authority. Define what happens to in-flight work; revocation cannot undo completed external effects.

Dependencies: protected host installation and interface. Can initially be tested with isolated fake environments without either container backend. The credential broker consumes this contract but must not duplicate it. Full-access owner-account host agents remain trusted.
