/**
 * Smoke: upload a tiny PNG as avatar via /v1/me/avatar (dev auth).
 */
import 'dotenv/config';

const PORT = process.env.PORT ?? '8000';
const BASE = `${process.env.SMOKE_ROOT_URL ?? `http://localhost:${PORT}`}/v1`;
const token = 'dev:consumer:c0c0c0c0-0000-4000-a000-000000000001';

// 1x1 PNG
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function main() {
  // ensure session user exists
  await fetch(`${BASE}/auth/session`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });

  const boundary = '----BuddiesBoundary' + Date.now();
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="avatar.png"\r\n` +
        `Content-Type: image/png\r\n\r\n`,
    ),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const res = await fetch(`${BASE}/me/avatar`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const text = await res.text();
  console.log('status', res.status);
  console.log(text.slice(0, 500));
  if (!res.ok) process.exit(1);
  const json = JSON.parse(text) as { user?: { avatarUrl?: string; avatarStorageRef?: string } };
  if (!json.user?.avatarStorageRef) {
    throw new Error('missing avatarStorageRef');
  }
  console.log('AVATAR UPLOAD OK', json.user.avatarStorageRef);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
