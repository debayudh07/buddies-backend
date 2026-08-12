/** Smoke: mutual rating blend / EWMA (no DB). */
function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
function round1(n) {
  return Math.round(n * 10) / 10;
}
function perfStarsSupplier(input) {
  const onTime = clamp(input.onTimeRate / 100, 0, 1);
  const returns = clamp(1 - input.returnRate / 100, 0, 1);
  const adjust = clamp(1 - Math.min(input.challanAdjustRate, 100) / 100, 0, 1);
  const perf01 = clamp(0.55 * onTime + 0.3 * returns + 0.15 * adjust, 0, 1);
  return round1(1 + 4 * perf01);
}
function perfStarsConsumer(trustScore) {
  return round1(1 + 4 * clamp(trustScore / 100, 0, 1));
}
function blendRating(avgPeerStars, ratingCount, perfStars) {
  if (!ratingCount || avgPeerStars == null) return round1(perfStars);
  return round1(0.65 * avgPeerStars + 0.35 * perfStars);
}
function ewmaRating(current, stars, alpha = 0.2) {
  return round1(current * (1 - alpha) + stars * alpha);
}
function ewmaTrustFromStars(currentTrust, stars, alpha = 0.2) {
  const target = (stars / 5) * 100;
  return round1(clamp(currentTrust * (1 - alpha) + target * alpha, 0, 100));
}

let failed = 0;
function assert(name, cond, detail) {
  if (!cond) {
    failed += 1;
    console.error('FAIL', name, detail ?? '');
  } else {
    console.log('OK', name, detail ?? '');
  }
}

assert('perfect supplier', perfStarsSupplier({ onTimeRate: 100, returnRate: 0, challanAdjustRate: 0 }) === 5);
assert('bad supplier', perfStarsSupplier({ onTimeRate: 0, returnRate: 100, challanAdjustRate: 100 }) === 1);
assert('consumer trust 100', perfStarsConsumer(100) === 5);
assert('consumer trust 0', perfStarsConsumer(0) === 1);
assert('blend empty', blendRating(null, 0, 4.2) === 4.2);
assert('blend peers', blendRating(4, 1, 5) === 4.4); // 2.6+1.75
assert('ewma', ewmaRating(5, 1) === 4.2);
assert('trust from 1 star', ewmaTrustFromStars(100, 1) === 84);

// Idempotent semantics (logic-level): second submit returns existing
const store = new Map();
function submit(orderId, fromUserId, stars) {
  const key = `${orderId}:${fromUserId}`;
  if (store.has(key)) return { alreadyApplied: true, rating: store.get(key) };
  const rating = { orderId, fromUserId, stars };
  store.set(key, rating);
  return { alreadyApplied: false, rating };
}
const a = submit('o1', 'u1', 5);
const b = submit('o1', 'u1', 1);
assert('first submit', !a.alreadyApplied && a.rating.stars === 5);
assert('idempotent resubmit', b.alreadyApplied && b.rating.stars === 5);
assert('peer independent', !submit('o1', 'u2', 4).alreadyApplied);

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll rating smoke checks passed');
