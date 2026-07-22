/**
 * Auth verification: Supabase JWT path + Google provider config.
 * Run: npx tsx scripts/auth-check.ts
 *
 * Cannot complete a real Google browser OAuth here; this verifies:
 * 1) GoTrue reports whether Google is enabled
 * 2) A Supabase-issued JWT is accepted by Express /v1/auth/session
 */
/// <reference types="node" />
import 'dotenv/config';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const PORT = process.env.PORT ?? '8000';
const ROOT = process.env.SMOKE_ROOT_URL ?? `http://localhost:${PORT}`;
const BASE = `${ROOT}/v1`;

const supabaseUrl = process.env.SUPABASE_URL ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

type Step = { ok: boolean; name: string; detail?: string };
const steps: Step[] = [];

function log(msg: string) {
  console.log(msg);
}

function pass(name: string, detail?: string) {
  steps.push({ ok: true, name, detail });
  log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function warn(name: string, detail: string) {
  steps.push({ ok: true, name, detail: `WARN: ${detail}` });
  log(`  ⚠ ${name} — ${detail}`);
}

function fail(name: string, detail: string): never {
  steps.push({ ok: false, name, detail });
  throw new Error(`[FAIL] ${name}: ${detail}`);
}

async function main() {
  log(`\n=== Auth check (Supabase + Google provider) ===\n`);

  if (!supabaseUrl || !anonKey) {
    fail('env', 'SUPABASE_URL / SUPABASE_ANON_KEY missing');
  }
  pass('supabase env present', supabaseUrl);

  // 1) Provider settings (includes Google)
  log('1. GoTrue /auth/v1/settings');
  const settingsRes = await fetch(`${supabaseUrl}/auth/v1/settings`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
  });
  if (!settingsRes.ok) {
    fail('auth settings', `HTTP ${settingsRes.status}`);
  }
  const settings = (await settingsRes.json()) as {
    external?: Record<string, boolean>;
    disable_signup?: boolean;
  };
  const external = settings.external ?? {};
  pass('auth settings reachable');

  const googleEnabled = external.google === true;
  if (googleEnabled) {
    pass('Google provider enabled in Supabase Auth');
  } else {
    warn(
      'Google provider',
      'external.google=false — enable in Supabase Dashboard → Authentication → Providers → Google (Client ID + Secret)',
    );
  }

  const enabledProviders = Object.entries(external)
    .filter(([, v]) => v)
    .map(([k]) => k);
  pass('enabled providers', enabledProviders.join(', ') || '(none)');

  // 2) Issue a real Supabase JWT (email user via service role) and hit Express
  log('\n2. Supabase JWT → Express /auth/session');
  if (!serviceKey) {
    fail('service role', 'SUPABASE_SERVICE_ROLE_KEY missing — cannot mint test user JWT');
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const email = `socket-auth-smoke-${Date.now()}@buddies.test`;
  const password = `SmokeTest!${Date.now()}`;

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: 'Auth Smoke User' },
    app_metadata: { role: 'consumer' },
  });
  if (createErr || !created.user) {
    fail('createUser', createErr?.message ?? 'no user');
  }
  pass('admin createUser', created.user.id);

  const anon = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signedIn, error: signErr } = await anon.auth.signInWithPassword({ email, password });
  if (signErr || !signedIn.session?.access_token) {
    fail('signInWithPassword', signErr?.message ?? 'no access_token');
  }
  pass('got Supabase access_token');

  const sessionRes = await fetch(`${BASE}/auth/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${signedIn.session.access_token}` },
  });
  const sessionBody = await sessionRes.text();
  if (!sessionRes.ok) {
    fail('express auth/session', `HTTP ${sessionRes.status} ${sessionBody.slice(0, 300)}`);
  }
  let sessionJson: any;
  try {
    sessionJson = JSON.parse(sessionBody);
  } catch {
    fail('express auth/session', 'invalid JSON');
  }
  if (!sessionJson.user?.id) {
    fail('express auth/session', 'missing user in response');
  }
  pass('Express accepts Supabase JWT', `app user ${sessionJson.user.id}`);

  // Cleanup test user
  await admin.auth.admin.deleteUser(created.user.id);
  pass('cleaned up test user');

  log('\n=== AUTH SUMMARY ===');
  log(`Passed checks: ${steps.filter((s) => s.ok).length}/${steps.length}`);
  if (googleEnabled) {
    log('Google: provider ON — Flutter can use supabase.auth.signInWithOAuth({ provider: "google" })');
    log('         then send the access_token as Authorization: Bearer <token>');
  } else {
    log('Google: provider OFF — turn it on in Supabase, then Flutter Google sign-in will work with the same JWT path verified above.');
  }
  log('AUTH CHECK OK\n');
}

main().catch((e) => {
  console.error('\n' + (e instanceof Error ? e.message : String(e)));
  for (const s of steps.filter((x) => !x.ok)) {
    console.error(`  ✗ ${s.name}: ${s.detail}`);
  }
  process.exit(1);
});
