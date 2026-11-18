# Preserve learning history after refunds

Approving a Refund Request must revoke purchased course access without misrepresenting the learner's past participation. We delete the learner's current Enrollment but preserve Course Progress, viewing history, ratings, comments, and discussion activity. Preserving history is auditable, reversible, and allows a later purchase to resume learning; deleting the Enrollment without tracing other access sources is an accepted simplicity trade-off.

## Considered Options

- **Delete the Enrollment and preserve learning history — chosen.** This separates current access from past participation and lets a later purchase resume learning.
- **Delete the Enrollment and all learning history.** This cleanly resets the learner but irreversibly erases factual activity and weakens auditability.
- **Retain the Enrollment with a revoked status and track its access source.** This models enrollment history and multiple access sources precisely, but adds lifecycle and source-linking complexity that is not justified yet.
