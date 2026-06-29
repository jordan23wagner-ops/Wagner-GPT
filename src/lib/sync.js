// Local-first sync layer: localStorage is the fast cache, Supabase is the
// durable backup. The app always works offline; Supabase syncs in the
// background when available.
//
// Strategy:
//   Load  → fetch from Supabase, merge with localStorage (latest wins)
//   Save  → write localStorage immediately, then async push to Supabase
//
// Single-user app — no auth, no conflict resolution beyond "last write wins."

import { supabase, hasSupabase } from './supabase'

// ---- Conversations ----

export async function syncConversationsDown(localConvs) {
  if (!hasSupabase) return localConvs

  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .order('updated_at', { ascending: false })

    if (error) { console.warn('Supabase conversations fetch failed:', error.message); return localConvs }
    if (!data || data.length === 0) return localConvs

    const remoteMap = new Map(data.map((r) => [r.id, {
      id: r.id,
      title: r.title,
      messages: r.messages,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }]))

    const localMap = new Map((localConvs || []).map((c) => [c.id, c]))

    // Merge: for each conversation, keep whichever version has the later updatedAt.
    const allIds = new Set([...remoteMap.keys(), ...localMap.keys()])
    const merged = []
    for (const id of allIds) {
      const remote = remoteMap.get(id)
      const local = localMap.get(id)
      if (remote && local) {
        merged.push((remote.updatedAt || 0) >= (local.updatedAt || 0) ? remote : local)
      } else {
        merged.push(remote || local)
      }
    }

    merged.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return merged
  } catch (err) {
    console.warn('Supabase sync down failed:', err.message)
    return localConvs
  }
}

export async function syncConversationUp(conv) {
  if (!hasSupabase || !conv) return

  try {
    await supabase.from('conversations').upsert({
      id: conv.id,
      title: conv.title || 'New chat',
      messages: conv.messages || [],
      created_at: conv.createdAt || Date.now(),
      updated_at: conv.updatedAt || Date.now(),
    }, { onConflict: 'id' })
  } catch (err) {
    console.warn('Supabase conversation push failed:', err.message)
  }
}

export async function syncDeleteConversation(id) {
  if (!hasSupabase) return
  try {
    await supabase.from('conversations').delete().eq('id', id)
  } catch (err) {
    console.warn('Supabase conversation delete failed:', err.message)
  }
}

// ---- Garden state ----

export async function syncGardenDown(localState) {
  if (!hasSupabase) return localState

  try {
    const { data, error } = await supabase
      .from('garden_state')
      .select('*')
      .eq('id', 1)
      .single()

    if (error || !data) return localState

    const remote = data.data
    if (!remote || !remote.version) return localState

    const remoteTs = data.updated_at || 0
    const localTs = localState?._syncedAt || 0

    return remoteTs >= localTs ? { ...remote, _syncedAt: remoteTs } : localState
  } catch (err) {
    console.warn('Supabase garden fetch failed:', err.message)
    return localState
  }
}

export async function syncGardenUp(state) {
  if (!hasSupabase || !state) return

  const now = Date.now()
  try {
    await supabase.from('garden_state').upsert({
      id: 1,
      data: state,
      updated_at: now,
    }, { onConflict: 'id' })
  } catch (err) {
    console.warn('Supabase garden push failed:', err.message)
  }
}
