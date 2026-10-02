// Exact rational arithmetic — the engine's time model (audit §7).
// Times cross the wire as [num, den] i64 pairs. Floats are used ONLY for
// pixel layout; every value that goes BACK to the engine is computed in
// exact integer math.

export type Rat = [number, number];

const B = BigInt;

export function ratCmp(a: Rat, b: Rat): number {
  const l = B(a[0]) * B(b[1]);
  const r = B(b[0]) * B(a[1]);
  return l < r ? -1 : l > r ? 1 : 0;
}

export function ratAdd(a: Rat, b: Rat): Rat {
  return ratReduce([
    Number(B(a[0]) * B(b[1]) + B(b[0]) * B(a[1])),
    Number(B(a[1]) * B(b[1])),
  ]);
}

export function ratSub(a: Rat, b: Rat): Rat {
  return ratReduce([
    Number(B(a[0]) * B(b[1]) - B(b[0]) * B(a[1])),
    Number(B(a[1]) * B(b[1])),
  ]);
}

export function ratMul(a: Rat, b: Rat): Rat {
  return [Number(B(a[0]) * B(b[0])), Number(B(a[1]) * B(b[1]))];
}

export function ratIsPositive(a: Rat): boolean {
  return ratCmp(a, [0, 1]) > 0;
}

/// floor division, exact
export function ratFloor(a: Rat): number {
  const n = B(a[0]);
  const d = B(a[1]);
  const q = n / d;
  return Number(q);
}

/// exact mm:ss.mmm timecode (integer math, no float drift)
export function timecode(t: Rat): string {
  const n = B(t[0]);
  const d = B(t[1]);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / d;
  const rem = abs - whole * d;
  const millis = (rem * 1000n) / d;
  const mm = whole / 60n;
  const ss = whole - mm * 60n;
  const pad = (x: bigint, w: number) => x.toString().padStart(w, "0");
  return `${neg ? "-" : ""}${pad(mm, 2)}:${pad(ss, 2)}.${pad(millis, 3)}`;
}

export function ratToSeconds(t: Rat): number {
  return t[0] / t[1];
}

/// snap a float seconds value to the project tick axis (exact rational);
/// the tick axis is 48000/1 (audio-rate ticks — the clients' shared decision)
export const TICK_DEN = 48000;

export function secondsToTickRat(secs: number): Rat {
  const num = Math.round(secs * TICK_DEN);
  return [num, TICK_DEN];
}

/// gcd-reduce a rational so JSON payloads stay canonical
export function ratReduce(a: Rat): Rat {
  const gcd = (x: bigint, y: bigint): bigint => (y === 0n ? x : gcd(y, x % y));
  const n = B(a[0]);
  const d = B(a[1]);
  if (d === 0n) return a;
  const g = gcd(n < 0n ? -n : n, d);
  return [Number(n / g), Number(d / g)];
}
