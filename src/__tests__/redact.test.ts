/**
 * Secret redaction tests
 */

import { redactString, redactValue, toPublicUser, toPublicUsers, REDACTED } from '../utils/redact.js';
import type { User } from '../types/index.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

describe('redactString', () => {
  it('masks JSON secret fields', () => {
    const out = redactString('{"cookies":{"j":"abc123"},"t":"turnstile-token","name":"bob"}');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('turnstile-token');
    expect(out).toContain('"name":"bob"');
  });

  it('masks header-style secrets', () => {
    expect(redactString('Cookie: j=abc; s=def')).toBe(`Cookie: ${REDACTED}`);
    expect(redactString('authorization: Bearer xyz')).toBe(`authorization: ${REDACTED}`);
  });

  it('masks cookie pairs and JWTs in free text', () => {
    expect(redactString('sent j=abc123; to server')).toBe(`sent j=${REDACTED}; to server`);
    expect(redactString(`token ${JWT} expired`)).toBe(`token ${REDACTED} expired`);
  });

  it('leaves ordinary text untouched', () => {
    const text = 'Painted 30 px at 12,34. status=ok, pixels=5, jobs=2';
    expect(redactString(text)).toBe(text);
  });
});

describe('redactValue', () => {
  it('masks secret keys at any depth and keeps other fields', () => {
    const input = { user: { name: 'bob', cookies: { j: 'abc', s: 'def' } }, headers: { Authorization: 'x' }, count: 3 };
    expect(redactValue(input)).toEqual({
      user: { name: 'bob', cookies: REDACTED },
      headers: { Authorization: REDACTED },
      count: 3,
    });
  });

  it('does not mutate the input', () => {
    const input = { token: 'secret' };
    redactValue(input);
    expect(input.token).toBe('secret');
  });

  it('handles errors and cycles', () => {
    const err = new Error(`login failed with ${JWT}`);
    const out = redactValue(err) as { message: string; stack?: string };
    expect(out.message).toBe(`login failed with ${REDACTED}`);
    expect(out.stack ?? '').not.toContain(JWT);

    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(() => redactValue(cyclic)).not.toThrow();
  });
});

describe('toPublicUser', () => {
  const user: User = { id: '42', name: 'bob', cookies: { j: 'abc', s: 'def' }, droplets: 10 };

  it('removes cookies and reports their presence', () => {
    const pub = toPublicUser(user);
    expect(pub).toEqual({ id: '42', name: 'bob', droplets: 10, hasCookies: true });
    expect(JSON.stringify(pub)).not.toContain('abc');
  });

  it('maps a whole user collection', () => {
    const out = toPublicUsers({ '42': user });
    expect(Object.keys(out)).toEqual(['42']);
    expect(out['42']).not.toHaveProperty('cookies');
  });
});
