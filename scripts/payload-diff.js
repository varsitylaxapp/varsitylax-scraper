#!/usr/bin/env node
// Structural payload diff for the ADDITIVE byte-identity policy.
//
// The byte diff alone can no longer be the proof: an additive change by
// definition changes bytes. This walks both captures and classifies every
// difference as ADDED / REMOVED / CHANGED / REORDERED, so "additions only" is a
// claim that can actually be checked rather than asserted.
//
// A release passes only when REMOVED, CHANGED and REORDERED are all empty.
// Key ORDER is compared too: JSON objects are ordered in practice, clients can
// depend on it, and a reorder is not an addition.
//
// Usage: node scripts/payload-diff.js <beforeDir> <afterDir>
const fs = require('fs');
const path = require('path');

const [beforeDir, afterDir] = process.argv.slice(2);
if (!beforeDir || !afterDir) {
  console.error('usage: payload-diff.js <beforeDir> <afterDir>');
  process.exit(2);
}

// Time-varying fields; differences here are noise, not payload evolution.
const VOLATILE = new Set(['updated', 'lastScrape', 'lastGameWrite', 'lastSnapshot', 'scrapedAt', 'scraped_at']);

const added = [], removed = [], changed = [], reordered = [];

/**
 * An element's stable identity, or null if it has none.
 *
 * Deliberately narrow: a game by its NATURAL KEY (calendar day plus the unordered team
 * pair — the same identity the API itself uses for `advancesTo`, and never the numeric
 * id, which is environment-local), a team by slug, a ranking by slug, a bracket by key.
 * Anything else falls back to positional comparison rather than guessing an identity.
 */
function elementKey(el) {
  if (!el || typeof el !== 'object' || Array.isArray(el)) return null;
  if (el.home && el.away && (el.dateKey || el.date)) {
    const day = String(el.dateKey || el.date).slice(0, 10);
    const pair = [el.home.slug, el.away.slug].sort().join('~');
    return `${day}~${pair}`;
  }
  if (el.slug) return String(el.slug);
  if (el.key) return String(el.key);
  if (el.code) return String(el.code);
  return null;
}

function walk(a, b, p) {
  if (Array.isArray(a) && Array.isArray(b)) {
    // ── KEY-BASED WHERE THE ELEMENTS HAVE AN IDENTITY ──────────────────────
    //
    // Positional comparison cannot tell "a row was inserted" from "every row changed".
    // On 2026-08-03 this tool reported 7747 CHANGED for an import that inserted 17 games
    // and altered none — values flipping BOTH directions in near-equal counts
    // (`isConference: true -> false` x114 alongside `false -> true` x114), which is the
    // signature of a date-sorted array shifting under an insert. The real answer, found
    // by comparing the same payloads BY NATURAL KEY, was 17 added and ZERO field
    // differences across the 871 games present in both.
    //
    // That failure mode is not merely noisy: an inserted row makes every later row look
    // changed, so a genuine change hides inside thousands of false ones. The tool that
    // guards the additive policy must not be the tool that buries a violation.
    //
    // So: elements that carry an identity are matched by it, and only elements with the
    // SAME identity are compared field by field. Anything without an identity keeps the
    // positional behaviour, which is correct for a fixed-shape list.
    const ka = a.map(elementKey), kb = b.map(elementKey);
    if (ka.every(Boolean) && kb.every(Boolean) && new Set(ka).size === ka.length) {
      const bi = new Map(b.map((el, i) => [kb[i], el]));
      const ai = new Map(a.map((el, i) => [ka[i], el]));
      for (const k of kb) if (!ai.has(k)) added.push(`${p}[] +1 element (key ${k})`);
      for (const k of ka) if (!bi.has(k)) removed.push(`${p}[] -1 element (key ${k})`);
      for (const k of ka) if (bi.has(k)) walk(ai.get(k), bi.get(k), `${p}[${k}]`);
      return;
    }
    if (a.length !== b.length) changed.push(`${p}: array length ${a.length} -> ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) walk(a[i], b[i], `${p}[${i}]`);
    return;
  }
  const aObj = a && typeof a === 'object', bObj = b && typeof b === 'object';
  if (aObj && bObj) {
    const ka = Object.keys(a), kb = Object.keys(b);
    for (const k of kb) if (!ka.includes(k)) added.push(`${p}.${k} = ${JSON.stringify(b[k])}`);
    for (const k of ka) if (!kb.includes(k)) removed.push(`${p}.${k}`);
    // order of the keys that survived must be unchanged
    const common = ka.filter(k => kb.includes(k));
    const orderB = kb.filter(k => ka.includes(k));
    if (common.join(',') !== orderB.join(',')) reordered.push(`${p}: ${common.join(',')} -> ${orderB.join(',')}`);
    for (const k of common) walk(a[k], b[k], `${p}.${k}`);
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    const leaf = p.split('.').pop().replace(/\[\d+\]$/, '');
    if (!VOLATILE.has(leaf)) changed.push(`${p}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  }
}

const files = fs.readdirSync(beforeDir).filter(f => f.endsWith('.json')).sort();
let missing = 0;
for (const f of files) {
  const bp = path.join(afterDir, f);
  if (!fs.existsSync(bp)) { removed.push(`FILE ${f}`); missing++; continue; }
  let A, B;
  try {
    A = JSON.parse(fs.readFileSync(path.join(beforeDir, f), 'utf8'));
    B = JSON.parse(fs.readFileSync(bp, 'utf8'));
  } catch (e) { changed.push(`${f}: unparseable — ${e.message}`); continue; }
  walk(A, B, f.replace(/\.json$/, ''));
}
for (const f of fs.readdirSync(afterDir).filter(f => f.endsWith('.json'))) {
  if (!fs.existsSync(path.join(beforeDir, f))) added.push(`FILE ${f}`);
}

const uniq = a => [...new Set(a)];
const group = list => {
  const m = new Map();
  for (const x of list) {
    const key = x.replace(/\[\d+\]/g, '[]').replace(/ = .*$/, '');
    m.set(key, (m.get(key) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

console.log(`\nfiles compared: ${files.length}${missing ? `  (missing in after: ${missing})` : ''}`);
console.log(`\nADDED     ${added.length}`);
for (const [k, n] of group(added)) console.log(`   + ${k}  ×${n}`);
if (added.length) console.log(`   e.g. ${uniq(added).slice(0, 3).join('\n        ')}`);
console.log(`\nREMOVED   ${removed.length}`);   for (const [k, n] of group(removed))   console.log(`   - ${k}  ×${n}`);
console.log(`CHANGED   ${changed.length}`);     for (const [k, n] of group(changed).slice(0, 12)) console.log(`   ~ ${k}  ×${n}`);
console.log(`REORDERED ${reordered.length}`);   for (const [k, n] of group(reordered).slice(0, 8)) console.log(`   ↕ ${k}  ×${n}`);

const pass = removed.length === 0 && changed.length === 0 && reordered.length === 0;
console.log(`\n=== ${pass ? 'ADDITIONS ONLY — policy satisfied' : 'POLICY VIOLATION — not additions only'} ===\n`);
process.exit(pass ? 0 : 1);
