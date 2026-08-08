/**
 * Smoke: Supabase JWT + intendedRole supplier → Express /auth/session
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const PORT = process.env.PORT ?? '8000';
const BASE = `${process.env.SMOKE_ROOT_URL ?? `http://localhost:${PORT}`}/v1`;
const supabaseUrl = process.env.SUPABASE_URL ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

async function main() {
  if (!supabaseUrl || !anonKey || !serviceKey) {
    throw new Error('Missing Supabase env');
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const email = `supplier-role-smoke-${Date.now()}@buddies.test`;
  const password = `SmokeTest!${Date.now()}`;

  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (cErr || !created.user) throw cErr ?? new Error('no user');

  try {
    const client = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: signed, error: sErr } = await client.auth.signInWithPassword({
      email,
      password,
    });
    if (sErr || !signed.session) throw sErr ?? new Error('no session');

    const res = await fetch(`${BASE}/auth/session`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${signed.session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ intendedRole: 'supplier' }),
    });
    const body = (await res.json()) as { user?: { id?: string; role?: string } };
    console.log('status', res.status, 'role', body.user?.role, 'id', body.user?.id);
    if (!res.ok || body.user?.role !== 'supplier') {
      throw new Error(`expected supplier role, got ${JSON.stringify(body)}`);
    }
    console.log('SUPPLIER SESSION OK');
  } finally {
    await admin.auth.admin.deleteUser(created.user.id);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
