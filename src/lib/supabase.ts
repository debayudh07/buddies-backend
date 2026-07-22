import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';

let admin: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient | null {
  if (!config.supabaseUrl || !config.supabaseServiceKey) return null;
  if (!admin) {
    admin = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return admin;
}
