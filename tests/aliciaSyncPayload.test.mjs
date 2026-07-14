// Regression test for the two-person WRONG-IDENTITY autofill bug (fixed in commit 0ddaaeb, then
// extracted into buildSyncPayload for testability). The extension holds exactly ONE profile. The
// Jobs.jsx sync effect used to early-return when the selected person had no active résumé text, so
// switching to such a person left the extension holding the PREVIOUS person's identity and it would
// silently autofill applications as the wrong person. buildSyncPayload is the pure core of the fix:
// even with no active résumé it must still carry THIS person's profile with the résumé-derived
// fields CLEARED (not omitted, not the previous person's). These tests lock that in without needing
// React/jsdom — they exercise the real, unmodified src/lib/aliciaBridge.js helper the effect calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSyncPayload } from '../src/lib/aliciaBridge.js'

const ALICIA = { firstName: 'Alicia', lastName: 'Wagner', email: 'alicia@example.com', phone: '5550001111' }
const JORDAN = { firstName: 'Jordan', lastName: 'Wagner', email: 'jordan@example.com', phone: '5552223333' }

test('no active résumé (null): résumé fields cleared, but THIS person\'s profile still sent', () => {
  // The exact person-switch case that used to early-return and strand the previous identity.
  const p = buildSyncPayload(null, ALICIA)
  assert.equal(p.resumeText, '', 'resumeText must be cleared, not left as the previous résumé')
  assert.equal(p.resumeName, null)
  assert.equal(p.resumeFile, null)
  assert.deepEqual(p.profile, ALICIA, 'profile must be the current person, always present')
})

test('résumé present but empty text: still treated as no-résumé (fields cleared)', () => {
  const p = buildSyncPayload({ id: 'r1', name: 'Old.pdf', text: '', file: { name: 'Old.pdf' } }, ALICIA)
  assert.equal(p.resumeText, '')
  assert.equal(p.resumeName, null)
  assert.equal(p.resumeFile, null)
  assert.deepEqual(p.profile, ALICIA)
})

test('active résumé present: real résumé fields flow through unchanged (normal case)', () => {
  const resume = { id: 'r2', name: 'Alicia_PM.pdf', text: 'Experienced PM…', file: { name: 'Alicia_PM.pdf', type: 'application/pdf', b64: 'AAA' } }
  const p = buildSyncPayload(resume, ALICIA)
  assert.equal(p.resumeText, 'Experienced PM…')
  assert.equal(p.resumeName, 'Alicia_PM.pdf')
  assert.deepEqual(p.resumeFile, resume.file)
  assert.deepEqual(p.profile, ALICIA)
})

test('active résumé with no file: resumeFile is null, not undefined', () => {
  const p = buildSyncPayload({ id: 'r3', name: 'nofile.txt', text: 'hi' }, JORDAN)
  assert.equal(p.resumeFile, null)
})

test('profile is passed straight through, never a stale/substituted one', () => {
  // Whatever profile the caller passes (loadProfile() = current person) is exactly what ships —
  // the helper never caches or falls back to a different profile. Two different people, same call.
  assert.equal(buildSyncPayload(null, JORDAN).profile, JORDAN)
  assert.equal(buildSyncPayload(null, ALICIA).profile, ALICIA)
})
