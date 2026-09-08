import { describe, expect, it } from 'vitest';
import { parseAuthHash } from '../public/auth-session.js';

describe('GitHub auth session parsing', () => {
  it('reads the auth payload from the hash and exposes the user token', () => {
    const payload = {
      token: 'sample-token',
      user: {
        email: 'jntcargo193a@gmail.com',
        name: 'wismilak-slim',
        githubUsername: 'wismilak-slim',
        avatarUrl: 'https://example.com/avatar.png',
      },
    };

    const hash = '#auth=' + encodeURIComponent(JSON.stringify(payload));
    expect(parseAuthHash(hash)).toEqual(payload);
  });
});
