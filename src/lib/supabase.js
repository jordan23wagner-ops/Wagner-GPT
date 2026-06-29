// Supabase client — the anon key is publishable by design (like Stripe's
// publishable key). Security comes from Row Level Security policies on the
// database, not from hiding this key. This is standard Supabase practice
// for frontend apps.

import { createClient } from '@supabase/supabase-js'

const url = 'https://mfzzcrsgslkpvzvtveao.supabase.co'
const key = 'sb_publishable_7-pjVrDnXLzAAjxXawBpWw_mCVTSR-Z'

export const supabase = createClient(url, key)
export const hasSupabase = true
