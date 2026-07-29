# iOS prompt sequence — lives in the other repo

The multi-state build's status record and prompt sequence P0–P7 is:

**`varsitylax-ios/docs/claude-code-prompts-ios-multistate.md`**

It moved there on 2026-07-29. Every remaining step (P3–P7) runs in the iOS repo, so
the status record lives where the work happens. This pointer exists so a session
starting in the scraper repo finds it rather than re-deriving state.

It was, until that date, an untracked file on the Desktop — the only record of the
project's status, in the one place version control could not see. That is the same
shape as the v1.6.0 incident (a shipped version number living only in an
uncommitted generated file for 17 days), with more at stake, since this file holds
the rulings that govern every remaining prompt.

P0 is the only step that runs in THIS repo, and it is done.
