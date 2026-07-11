// jobsStore.js — persistence for the Jobs tab (résumés, application tracker, contact/EEO profile).
//
// Local-first, mirroring the app's conversations/Garden pattern (src/lib/conversations.js,
// src/lib/sync.js): localStorage is the source of truth for a snappy UI; Supabase is an optional
// durable backup synced best-effort. If the `job_data` table doesn't exist (user hasn't run
// supabase-jobs-schema.sql), every cloud call is caught and no-ops — the UI keeps working locally.

import { supabase, hasSupabase } from './supabase'

const LS = { resumes: 'jobs.resumes', tracked: 'jobs.tracked', profile: 'jobs.profile', memory: 'jobs.memory', target: 'jobs.target', updatedAt: 'jobs.updatedAt' }

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

// ── Local getters/setters (synchronous, used everywhere in the UI) ──
export function loadResumes() { return readLS(LS.resumes, []) }
export function loadTracked() { return readLS(LS.tracked, []) }
export function loadProfile() { return readLS(LS.profile, {}) }
// Confirmed extra facts/skills the candidate approved (learned during deep tailoring). Each:
// { id, text, kind:'skill'|'fact', confirmedAt }. Injected into tailoring prompts; never invented.
export function loadMemory() { return readLS(LS.memory, []) }
// The saved Target Profile: the roles/industry/salary/location a user is actively hunting for, set
// once instead of re-typed every search. { titles, industry, salaryMin, remote, fullTime, country,
// location, autorun }. Distinct from `profile` (contact/EEO used for autofill).
export function loadTarget() { return readLS(LS.target, {}) }

export function saveResumes(arr) { if (writeLSIfChanged(LS.resumes, arr || [])) touch() }
export function saveTracked(arr) { if (writeLSIfChanged(LS.tracked, arr || [])) touch() }
export function saveProfile(obj) { if (writeLSIfChanged(LS.profile, obj || {})) touch() }
export function saveMemory(arr) { if (writeLSIfChanged(LS.memory, arr || [])) touch() }
export function saveTarget(obj) { if (writeLSIfChanged(LS.target, obj || {})) touch() }

function snapshot() {
  return { resumes: loadResumes(), tracked: loadTracked(), profile: loadProfile(), memory: loadMemory(), target: loadTarget(), updatedAt: readLS(LS.updatedAt, 0) }
}

// Bump the local updatedAt and schedule a debounced cloud push.
let pushTimer = null
function touch() {
  writeLS(LS.updatedAt, Date.now())
  if (!hasSupabase) return
  clearTimeout(pushTimer)
  pushTimer = setTimeout(() => { syncUp().catch(() => {}) }, 1500)
}

// ── Cloud sync (best-effort; a missing table just no-ops) ──
export async function syncUp() {
  if (!hasSupabase) return false
  const s = snapshot()
  try {
    const { error } = await supabase.from('job_data').upsert({
      id: 1,
      data: { resumes: s.resumes, tracked: s.tracked, profile: s.profile, memory: s.memory, target: s.target },
      updated_at: s.updatedAt || Date.now(),
    })
    return !error
  } catch { return false }
}

// Pull the cloud snapshot; if it's newer than local, adopt it into localStorage and return it.
// Returns the effective { resumes, tracked, profile } either way (local on any failure).
export async function syncDown() {
  const local = snapshot()
  if (!hasSupabase) return local
  try {
    const { data, error } = await supabase.from('job_data').select('data, updated_at').eq('id', 1).maybeSingle()
    if (error || !data || !data.data) return local
    const cloudAt = Number(data.updated_at || 0)
    if (cloudAt > (local.updatedAt || 0)) {
      const d = data.data
      if (Array.isArray(d.resumes)) writeLS(LS.resumes, d.resumes)
      if (Array.isArray(d.tracked)) writeLS(LS.tracked, d.tracked)
      if (d.profile && typeof d.profile === 'object') writeLS(LS.profile, d.profile)
      if (Array.isArray(d.memory)) writeLS(LS.memory, d.memory)
      if (d.target && typeof d.target === 'object') writeLS(LS.target, d.target)
      writeLS(LS.updatedAt, cloudAt)
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
