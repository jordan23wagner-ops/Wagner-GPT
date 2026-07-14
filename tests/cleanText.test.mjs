// Regression test for cleanText (api/jobs.js). Found live: Greenhouse returns its job `content`
// ENTITY-ENCODED (&lt;div&gt;...), and the old cleanText stripped the entities without recognizing
// them as encoded tags, leaving the tag NAMES as bare words -- descriptions rendered as literal
// "div class= content-intro h2 strong About Anthropic ...". The fix decodes entities before
// stripping tags. This affected EVERY Greenhouse job app-wide, just most visible via the new
// company-lookup feature which surfaces many Greenhouse jobs at once.
import { test } from 'node:test'
import assert from 'node:assert'

// jobs.js reads several env vars as module-level constants at import time; set the ones it needs so
// the import doesn't blow up (same pattern as tests/jobs.test.mjs). cleanText itself uses none.
process.env.BRAVE_KEY = 'x'
const { cleanText } = await import('../api/jobs.js')

test('cleanText: entity-encoded HTML (Greenhouse content) decodes to clean prose, no tag-name words left', () => {
  const gh = '&lt;div class=&quot;content-intro&quot;&gt;&lt;h2&gt;&lt;strong&gt;About Anthropic&lt;/strong&gt;&lt;/h2&gt;&lt;p&gt;Anthropic&#39;s mission is to create reliable, interpretable AI &amp; safe systems.&lt;/p&gt;'
  const out = cleanText(gh)
  assert.strictEqual(out, "About Anthropic Anthropic's mission is to create reliable, interpretable AI & safe systems.")
  // the specific symptom must be gone:
  assert.ok(!/\bdiv\b|\bstrong\b|\bcontent-intro\b|class=/.test(out), `tag-name words leaked into the description: ${out}`)
})

test('cleanText: already-literal HTML still strips cleanly (unchanged behavior)', () => {
  assert.strictEqual(cleanText('<p>Hello <strong>world</strong> &amp; more</p>'), 'Hello world & more')
})

test('cleanText: plain text is left intact', () => {
  assert.strictEqual(cleanText('Just a normal sentence.'), 'Just a normal sentence.')
})

test('cleanText: double-encoded entity is not promoted into a real tag', () => {
  // &amp;lt; is literal "&lt;" text, not an encoded tag -- must not collapse to "<tag>" and vanish
  // as a tag; the leftover-entity strip turns the remaining &lt;/&gt; into spaces, which is fine.
  assert.strictEqual(cleanText('Use &amp;lt;tag&amp;gt; in code'), 'Use tag in code')
})

test('cleanText: empty/nullish input is a safe empty string', () => {
  assert.strictEqual(cleanText(''), '')
  assert.strictEqual(cleanText(null), '')
  assert.strictEqual(cleanText(undefined), '')
})
