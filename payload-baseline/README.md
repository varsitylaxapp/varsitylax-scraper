# Payload baseline

A committed capture of every endpoint in `scripts/capture-payloads.sh`, so the additive
policy can be checked against a **durable** reference instead of one that lives in `/tmp`
and evaporates when the session ends.

    node scripts/payload-diff.js payload-baseline /tmp/after

## What this is and is not trustworthy for

`payload-diff.js` reports four categories, and this baseline serves them unequally:

- **ADDED / REMOVED / REORDERED — trustworthy indefinitely.** These are shape facts.
  A key that appears, disappears, or moves is a contract change regardless of how old
  the baseline is. This is the policy signal.
- **CHANGED — expected to drift.** Scores land, `updated` timestamps advance, teams'
  records move. A CHANGED entry here means "a value differs from whenever this was
  captured", which after a week is mostly ordinary data. Read it, do not gate on it.

## This does not replace the before/after protocol

The authoritative additive proof is still two captures minutes apart from the same
database — before the change, after the change — which holds the data still so that
CHANGED must be zero. That is what proves a release is additive. This directory answers
the different question of *what the shape was last time anyone looked*, which is the one
you cannot answer from `/tmp` a month later.

Re-capture (`rm -rf payload-baseline && ./scripts/capture-payloads.sh payload-baseline`)
after any deliberate payload change, in the same commit as the change.

## Captured from

Staging, season 2026, states OR/WA/AZ plus 2027 WA. Staging — not prod — because prod is
never probed outside a rolled-back transaction, and because staging is where the schema
lands first.
