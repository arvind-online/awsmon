import { describe, expect, it } from 'vitest';
import { LoginLimiter, SessionSigner, hashPassword, verifyPassword } from './auth.js';

const SECRET = 'x'.repeat(40);

describe('sessions', () => {
  it('accepts a fresh token and rejects tampering and expiry', () => {
    const s = new SessionSigner(SECRET);
    const t = s.issue('admin', 1000, 0);
    expect(s.verify(t, 500)?.user).toBe('admin');
    expect(s.verify(t, 1500)).toBeNull();
    expect(s.verify(t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), 500)).toBeNull();
  });

  it('revokes every outstanding token when the epoch moves (logout)', () => {
    let epoch = 0;
    const s = new SessionSigner(SECRET, () => epoch);
    const t = s.issue('admin', 60_000);
    expect(s.verify(t)).not.toBeNull();
    epoch++;
    expect(s.verify(t)).toBeNull();
  });
});

describe('passwords', () => {
  it('verifies scrypt hashes', async () => {
    const h = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
});

describe('LoginLimiter', () => {
  it('locks out after repeated failures and backs off', () => {
    let now = 0;
    const l = new LoginLimiter(3, () => now);
    for (let i = 0; i < 3; i++) l.fail('ip');
    expect(l.retryAfterSec('ip')).toBe(60);
    now += 61_000;
    expect(l.retryAfterSec('ip')).toBe(0);
    l.fail('ip');
    expect(l.retryAfterSec('ip')).toBe(120);
    l.success('ip');
    expect(l.retryAfterSec('ip')).toBe(0);
  });
});
