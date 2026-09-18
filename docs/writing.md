# Writing documentation

Keep one owner for each subject. Update the section that became wrong, delete obsolete claims and link from other docs. Explain constraints, decisions and cross-package gotchas; keep implementation details beside the code. Use the [docs index](README.md) to find the owner and register new subjects there.

## Maintain the product README

The root [README](../README.md) describes shipped features for developers deciding whether to use Vorton. Review it when adding, changing or removing user-facing behavior, and update it in the same change. Internal changes can leave it alone; explain why in the completion report.

- Verify implementation, tests and delivery status before claiming availability. Keep planned work in the roadmap and do not advertise source-only work awaiting deployment as shipped.
- Describe user workflows and outcomes. Give accounts, switching and profiles appropriate prominence alongside other capabilities. Keep storage and protocol details in their owning docs.
- Integrate features into the relevant section. Keep the overview balanced, credit inherited Paseo capabilities and verify comparisons with other products.
- Preserve working onboarding instructions and author-created media unless the user requests a change. Keep the account-switching animation beside the profile overview, retain its original asset URL and verify it still animates when editing that section. Report broken media; do not silently remove it or substitute a still image.
- Check changed links and read the finished README for repetition and stale claims. Link the update in the completion report, or state why none was needed.

## Voice and publication

Use plain, short sentences and second person. State the rule, then its reason when needed. Preserve useful specifics and the author's voice. Cut repeated explanations, hype, throat-clearing, vague hedges and setup-and-punchline contrasts. Avoid “honest”, “robust”, “seamless”, “powerful”, “simply”, “just” and “delightful”.

Use reusable instructions and placeholders. Keep real deployment paths, hostnames, device IDs, account inventories, credentials, backups and acceptance receipts outside Git. Follow [publication hygiene](publication-hygiene.md) before publishing or rewriting history.
