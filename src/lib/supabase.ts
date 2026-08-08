import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';

/**
 * Service-role client for trusted server work (Storage, Realtime Broadcast, admin).
 * Never expose this key to Flutter. Sessions are not persisted on the server.
 */
let admin: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient | null {
  if (!config.supabaseUrl || !config.supabaseServiceKey) return null;
  if (!admin) {
    admin = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
  return admin;
}
