// src/supabase.js — Supabase client singleton
// PWA pakai kredensial yang sama dengan addon Firefox (akun agung.kesmas@gmail.com)

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://qmwofsfpxjptpyvncylp.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_9gyUUsJUf1RZld9dgny3HA_o74o2mKv';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: 'recallfox-pwa-auth'
  },
  realtime: {
    params: { eventsPerSecond: 10 }
  }
});

export const STORAGE_BUCKET = 'screenshots';
export const VAULT_TABLE = 'vault_items';
export const NOTES_TABLE = 'notes';
