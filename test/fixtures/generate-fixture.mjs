// Run: node test/fixtures/generate-fixture.mjs > test/fixtures/reliance-5min-2025-01.csv
// Deterministic synthetic OHLCV with seeded PRNG for the 2025-01 NSE intraday session.

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(42);
const start = new Date('2025-01-02T03:45:00Z'); // 09:15 IST
const sessionsPerDay = 75; // 09:15..15:30 in 5min
const businessDays = 22;
let price = 1200;

console.log('symbol,ts_iso,interval,open,high,low,close,volume');
for (let d = 0; d < businessDays; d++) {
  for (let i = 0; i < sessionsPerDay; i++) {
    const ts = new Date(start.getTime() + d * 24 * 60 * 60_000 + i * 5 * 60_000).toISOString();
    const open = price;
    const drift = (rng() - 0.5) * 4; // ±2
    price = Math.max(1, price + drift);
    const close = price;
    const high = Math.max(open, close) + rng() * 1.5;
    const low = Math.min(open, close) - rng() * 1.5;
    const volume = Math.floor(1000 + rng() * 5000);
    console.log(`RELIANCE,${ts},5minute,${open.toFixed(2)},${high.toFixed(2)},${low.toFixed(2)},${close.toFixed(2)},${volume}`);
  }
}
