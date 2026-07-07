// jobsStore.js — persistence for the Jobs tab (résumés, application tracker, contact/EEO profile).
//
// Local-first, mirroring the app's conversations/Garden pattern (src/lib/conversations.js,
// src/lib/sync.js): localStorage is the source of truth for a snappy UI; Supabase is an optional
// durable backup synced best-effort. If the `job_data` table doesn't exist (user hasn't run
// supabase-jobs-schema.sql), every cloud call is caught and no-ops — the UI keeps working locally.

import { supabase, hasSupabase } from './supabase'

const LS = { resumes: 'jobs.resumes', tracked: 'jobs.tracked', profile: 'jobs.profile', updatedAt: 'jobs.updatedAt' }

function readLS(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v) }
  catch { return fallback }
}
function writeLS(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)) } catch { /* quota — ignore */ }
}

// ── Local getters/setters (synchronous, used everywhere in the UI) ──
export function loadResumes() { return readLS(LS.resumes, []) }
export function loadTracked() { return readLS(LS.tracked, []) }
export function loadProfile() { return readLS(LS.profile, {}) }

export function saveResumes(arr) { writeLS(LS.resumes, arr || []); touch() }
export function saveTracked(arr) { writeLS(LS.tracked, arr || []); touch() }
export function saveProfile(obj) { writeLS(LS.profile, obj || {}); touch() }

function snapshot() {
  return { resumes: loadResumes(), tracked: loadTracked(), profile: loadProfile(), updatedAt: readLS(LS.updatedAt, 0) }
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
      data: { resumes: s.resumes, tracked: s.tracked, profile: s.profile },
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
      writeLS(LS.updatedAt, cloudAt)
      return { resumes: d.resumes || [], tracked: d.tracked || [], profile: d.profile || {}, updatedAt: cloudAt }
    }
    return local
  } catch { return local }
}

// ── Convenience helpers for the active résumé ──
export function activeResume(resumes) {
  const list = resumes || loadResumes()
  return list.find((r) => r.isActive) || list[0] || null
}
