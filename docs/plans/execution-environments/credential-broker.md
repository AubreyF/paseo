# Credential broker and first GitHub connector

Status: future project, coordinated with the credential-management planning task.

Keep credentials and protected connector workers outside untrusted environments. Start with a small reviewed set of typed GitHub operations. Decide exact operations and approval rules before implementation. Do not offer arbitrary URLs, headers, shell execution, repository hooks, or guest-defined connector code under broker authority.

Consume host-issued environment/task grants. The protected interface approves the exact request revision. Log bounded audit metadata without credential contents; implement cancellation, revocation, retry idempotency, and clear outcomes for partial external effects.

The minimum protected installation and client boundary is shared with the first release. Identity and grants belong to the environment-grant project and must be built once. A broker can first serve a fixed test environment; generalized container orchestration is not a prerequisite.

Acceptance: guest cannot read tokens or replace workers/UI; forged grants and replay fail; approval cannot be retargeted; connector failures leak no credentials; completed actions remain attributable after reconnect.

Owner-account full-access agents are not isolated from owner-accessible broker credentials. Stronger protection from those agents requires a different OS authority boundary and is outside this design.

The earlier connector-only allowance was 3 to 5 engineering days assuming protected UI and grants already existed. The broader credential review budgets 16 to 25 days for the combined foundation/runtime/connector effort. Re-estimate the chosen operation set before scheduling. HTTPS interception, browser credentials, and provider migration each have separate project plans.
