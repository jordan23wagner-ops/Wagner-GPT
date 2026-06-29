// Supabase client — reads credentials from Vite env vars (VITE_ prefix).
// Returns null if not configured, so the app gracefully falls back to
// localStorage-only mode when Supabase isn't set up.

import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = url && key ? createClient(url, key) : null
export const hasSupabase = !!supabase
