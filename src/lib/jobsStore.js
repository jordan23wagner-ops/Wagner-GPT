// jobsStore.js — persistence for the Jobs tab (résumés, application tracker, contact/EEO profile).
//
// Local-first, mirroring the app's conversations/Garden pattern (src/lib/conversations.js,
// src/lib/sync.js): localStorage is the source of truth for a snappy UI; Supabase is an optional
// durable backup synced best-effort. If the `job_data` table doesn't exist (user hasn't run
// supabase-jobs-schema.sql), every cloud call is caught and no-ops — the UI keeps working locally.
//
// TWO-PERSON SCOPING: Jordan and Alicia run separate job searches. EVERY data type (résumés,
// tracker, contact/EEO profile, memory, Target Profile) is namespaced per person — localStorage
// keys are `jobs.<person>.<name>` and each person has their own cloud row (Jordan keeps the
// original row id 1 so pre-switcher data stays his; Alicia is row 2). Which person is selected is
// device-local (`jobs.person`, NOT synced) so Alicia's laptop stays on "Alicia" while Jordan's
// stays on "Jordan" without fighting over a shared setting.

import { supabase, hasSupabase } from './supabase'

export const PEOPLE = [
  { key: 'jordan', name: 'Jordan', cloudId: 1 },
  { key: 'alicia', name: 'Alicia', cloudId: 2 },
]
const DEFAULT_PERSON = 'jordan'
const PERSON_LS = 'jobs.person'

const NAMES = ['resumes', 'tracked', 'profile', 'memory', 'target', 'updatedAt']
const k = (person, name) => `jobs.${person}.${name}`

export function currentPerson() {
  try {
    const p = localStorage.getItem(PERSON_LS)
    return PEOPLE.some((x) => x.key === p) ? p : DEFAULT_PERSON
  } catch { return DEFAULT_PERSON }
}
export function setCurrentPerson(key) {
  if (!PEOPLE.some((x) => x.key === key)) return
  try { localStorage.setItem(PERSON_LS, key) } catch { /* selection just won't persist */ }
}
export function personName(key) {
  const p = PEOPLE.find((x) => x.key === (key || currentPerson()))
  return p ? p.name : 'Jordan'
}
const cloudId = (person) => (PEOPLE.find((x) => x.key === person) || PEOPLE[0]).cloudId

// One-time migration: pre-switcher data lived at unnamespaced `jobs.*` keys and belongs to Jordan
// (decided explicitly — the profile/tracker were his live-test data). Move, don't copy, so stale
// legacy keys can't shadow anything later. Idempotent: legacy keys are gone after the first run.
function migrateLegacy() {
  try {
    for (const name of NAMES) {
      const legacyKey = `jobs.${name}`
      const legacy = localStorage.getItem(legacyKey)
      if (legacy == null) continue
      if (localStorage.getItem(k(DEFAULT_PERSON, name)) == null) localStorage.setItem(k(DEFAULT_PERSON, name), legacy)
      localStorage.removeItem(legacyKey)
    }
  } catch { /* localStorage unavailable — nothing to migrate */ }
}
migrateLegacy()

// Pre-write defaults for any missing keys WITHOUT bumping updatedAt. The Jobs tab's mount-time
// save effects write their (empty) initial state back; on a fresh device that null→'[]' write
// used to count as a change, bump updatedAt to "now", and make the empty local snapshot look
// newer than the person's real cloud row — which the debounced push then overwrote. With the
// defaults pre-written, those mount saves are byte-identical no-ops and cloud data survives a
// first open on a new device. (Must run AFTER migrateLegacy so it never shadows migrated data.)
function initDefaults() {
  const DEFAULTS = { resumes: '[]', tracked: '[]', profile: '{}', memory: '[]', target: '{}' }
  try {
    for (const { key: person } of PEOPLE) {
      for (const [name, def] of Object.entries(DEFAULTS)) {
        if (localStorage.getItem(k(person, name)) == null) localStorage.setItem(k(person, name), def)
      }
    }
  } catch { /* localStorage unavailable */ }
}
initDefaults()

function readLS(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v) }
  catch { return fallback }
}
let quotaWarned = false
function writeLS(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)) }
  catch {
    if (!quotaWarned) { quotaWarned = true; console.warn('jobsStore: localStorage write failed (quota?) — Jobs data is no longer persisting locally') }
  }
}
// Write only if the serialized value actually changed; returns whether it did. Lets save* skip the
// updatedAt bump for no-op saves (e.g. the mount-time effects), so merely OPENING the app can't
// mark the local snapshot "newer" and clobber fresher cloud data from another device.
function writeLSIfChanged(key, val) {
  const s = JSON.stringify(val)
  try { if (localStorage.getItem(key) === s) return false } catch { /* fall through to write */ }
  try { localStorage.setItem(key, s) } catch {
    if (!quotaWarned) { quotaWarned = true; console.warn('jobsStore: localStorage write failed (quota?) — Jobs data is no longer persisting locally') }
    return false
  }
  return true
}

// ── Local getters/setters (synchronous, used everywhere in the UI; always the current person) ──
export function loadResumes() { return readLS(k(currentPerson(), 'resumes'), []) }
export function loadTracked() { return readLS(k(currentPerson(), 'tracked'), []) }
export function loadProfile() { return readLS(k(currentPerson(), 'profile'), {}) }
// Confirmed extra facts/skills the candidate approved (learned during deep tailoring). Each:
// { id, text, kind:'skill'|'fact', confirmedAt }. Injected into tailoring prompts; never invented.
export function loadMemory() { return readLS(k(currentPerson(), 'memory'), []) }
// The saved Target Profile: the roles/industry/salary/location a person is actively hunting for,
// set once instead of re-typed every search. { titles, industry, salaryMin, remote, fullTime,
// country, location, autorun }. Distinct from `profile` (contact/EEO used for autofill).
export function loadTarget() { return readLS(k(currentPerson(), 'target'), {}) }

export function saveResumes(arr) { if (writeLSIfChanged(k(currentPerson(), 'resumes'), arr || [])) touch() }
export function saveTracked(arr) { if (writeLSIfChanged(k(currentPerson(), 'tracked'), arr || [])) touch() }
export function saveProfile(obj) { if (writeLSIfChanged(k(currentPerson(), 'profile'), obj || {})) touch() }
export function saveMemory(arr) { if (writeLSIfChanged(k(currentPerson(), 'memory'), arr || [])) touch() }
export function saveTarget(obj) { if (writeLSIfChanged(k(currentPerson(), 'target'), obj || {})) touch() }

function snapshot(person) {
  return {
    resumes: readLS(k(person, 'resumes'), []), tracked: readLS(k(person, 'tracked'), []),
    profile: readLS(k(person, 'profile'), {}), memory: readLS(k(person, 'memory'), []),
    target: readLS(k(person, 'target'), {}), updatedAt: readLS(k(person, 'updatedAt'), 0),
  }
}

// Bump the local updatedAt and schedule a debounced cloud push. The person is captured at touch
// time so a quick person-switch inside the debounce window can't push person B's snapshot in
// place of person A's edit.
let pushTimer = null
function touch() {
  const person = currentPerson()
  writeLS(k(person, 'updatedAt'), Date.now())
  if (!hasSupabase) return
  clearTimeout(pushTimer)
  pushTimer = setTimeout(() => { syncUp(person).catch(() => {}) }, 1500)
}

// ── Cloud sync (best-effort; a missing table just no-ops). One row per person. ──
export async function syncUp(person = currentPerson()) {
  if (!hasSupabase) return false
  const s = snapshot(person)
  try {
    const { error } = await supabase.from('job_data').upsert({
      id: cloudId(person),
      data: { resumes: s.resumes, tracked: s.tracked, profile: s.profile, memory: s.memory, target: s.target },
      updated_at: s.updatedAt || Date.now(),
    })
    return !error
  } catch { return false }
}

// Pull the person's cloud snapshot; if it's newer than local, adopt it into localStorage and
// return it. Returns the effective data either way (local on any failure).
export async function syncDown(person = currentPerson()) {
  const local = snapshot(person)
  if (!hasSupabase) return local
  try {
    const { data, error } = await supabase.from('job_data').select('data, updated_at').eq('id', cloudId(person)).maybeSingle()
    if (error || !data || !data.data) return local
    const cloudAt = Number(data.updated_at || 0)
    if (cloudAt > (local.updatedAt || 0)) {
      const d = data.data
      if (Array.isArray(d.resumes)) writeLS(k(person, 'resumes'), d.resumes)
      if (Array.isArray(d.tracked)) writeLS(k(person, 'tracked'), d.tracked)
      if (d.profile && typeof d.profile === 'object') writeLS(k(person, 'profile'), d.profile)
      if (Array.isArray(d.memory)) writeLS(k(person, 'memory'), d.memory)
      if (d.target && typeof d.target === 'object') writeLS(k(person, 'target'), d.target)
      writeLS(k(person, 'updatedAt'), cloudAt)
      return { resumes: d.resumes || [], tracked: d.tracked || [], profile: d.profile || {}, memory: d.memory || [], target: d.target || {}, updatedAt: cloudAt }
    }
    return local
  } catch { return local }
}

// ── Convenience helpers for the active résumé ──
export function activeResume(resumes) {
  const list = resumes || loadResumes()
  return list.find((r) => r.isActive) || list[0] || null
}
