import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from './fsutil.js';

const KEYLEN = 32;
const N = 16384;
const R = 8;
const P = 1;

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEYLEN, { N: n, r, p }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Format: scrypt$N$r$p$saltB64$hashB64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHmac('sha256', 'cmp').update(a).digest();
  const hb = createHmac('sha256', 'cmp').update(b).digest();
  return timingSafeEqual(ha, hb);
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export interface Session {
  user: string;
  exp: number;
  sid: string;
  /** Session generation. Bumping the current epoch (on logout) revokes every token issued before. */
  ep: number;
}

/** Signed session token: base64url(payload).base64url(hmac), revocable via an epoch counter. */
export class SessionSigner {
  constructor(
    private readonly secret: string,
    private readonly epoch: () => number = () => 0,
  ) {
    if (secret.length < 32) throw new Error('auth.sessionSecret must be at least 32 characters');
  }

  issue(user: string, ttlMs: number, now = Date.now()): string {
    const payload = b64u(JSON.stringify({ user, exp: now + ttlMs, sid: randomBytes(12).toString('hex'), ep: this.epoch() } satisfies Session));
    return `${payload}.${this.sign(payload)}`;
  }

  verify(token: string | undefined, now = Date.now()): Session | null {
    if (!token) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig || !safeEqual(sig, this.sign(payload))) return null;
    try {
      const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Session;
      return s.exp > now && s.ep === this.epoch() ? s : null;
    } catch {
      return null;
    }
  }

  csrfFor(session: Session): string {
    return createHmac('sha256', this.secret).update(`csrf:${session.sid}`).digest('base64url');
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}

/** Escalating lockout per client key after repeated failures. */
export class LoginLimiter {
  private readonly state = new Map<string, { fails: number; lockedUntil: number }>();

  constructor(private readonly freeAttempts = 5, private readonly now: () => number = Date.now) {}

  retryAfterSec(key: string): number {
    const s = this.state.get(key);
    if (!s || s.lockedUntil <= this.now()) return 0;
    return Math.ceil((s.lockedUntil - this.now()) / 1000);
  }

  fail(key: string): void {
    if (this.state.size > 1000) this.prune();
    const s = this.state.get(key) ?? { fails: 0, lockedUntil: 0 };
    s.fails++;
    if (s.fails >= this.freeAttempts) s.lockedUntil = this.now() + Math.min(3_600_000, 60_000 * 2 ** (s.fails - this.freeAttempts));
    this.state.set(key, s);
  }

  success(key: string): void {
    this.state.delete(key);
  }

  /** Forget clients whose lockout has expired, so the map cannot grow without bound. */
  private prune(): void {
    const now = this.now();
    for (const [k, v] of this.state) if (v.lockedUntil <= now) this.state.delete(k);
  }
}

/** Persisted session epoch: survives restarts so a logout stays a logout. */
export class AuthState {
  private state = { epoch: 0 };

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const s = JSON.parse(readFileSync(file, 'utf8')) as { epoch?: number };
        if (Number.isInteger(s.epoch)) this.state.epoch = s.epoch as number;
      } catch {
        /* default */
      }
    }
  }

  epoch(): number {
    return this.state.epoch;
  }

  revokeAll(): void {
    this.state.epoch++;
    writeJsonAtomic(this.file, this.state);
  }
}
