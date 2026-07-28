// Alias normalization — ONE definition, two consumers.
//
// ⚠️ THIS MUST STAY BYTE-FOR-BYTE EQUIVALENT TO THE SQL GENERATED COLUMN in
// db/migrate/section-f2-alias-normalization.sql:
//
//     REPLACE(LOWER(TRIM(alias)), '-', ' ')
//
// Why this file exists: the rule was previously duplicated — SQL computed
// team_aliases.alias_normalized, and dual-write.js independently computed the
// lookup key with `String(s).trim().toLowerCase()`. On 2026-07-28 the SQL side
// gained hyphen folding and the JS side did not, so every spaced-hyphen alias
// silently stopped resolving:
//
//     JS  "aloha - southridge"   vs   DB  "aloha   southridge"
//
// Seven Oregon teams' opponent references broke and landed in
// unresolved_aliases. Row-count checks all still passed. If you change the rule,
// change BOTH and re-run scripts/staging-verify-scrape.js.
//
// Note the deliberate artifact: a hyphen WITH surrounding spaces yields a double
// space ("aloha   southridge"). That is fine as long as both sides agree, which
// is the entire point of this module. Collapsing whitespace would be tidier but
// produces 34 unique-key collisions on the existing data (verified 2026-07-28)
// and is gated behind a dedupe pass.

function normalizeAlias(s) {
  return String(s || '').trim().toLowerCase().replace(/-/g, ' ');
}

module.exports = { normalizeAlias };
