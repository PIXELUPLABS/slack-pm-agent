import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { FileOAuthProvider, McpAuthError } from '../../integrations/mcp-auth.js';

const baseDir = mkdtempSync(join(tmpdir(), 'mcp-auth-test-'));

after(() => rmSync(baseDir, { recursive: true, force: true }));

describe('FileOAuthProvider', () => {
  /** @type {FileOAuthProvider} */
  let provider;

  beforeEach(() => {
    provider = new FileOAuthProvider('testserver', { baseDir });
    provider.clear();
  });

  it('starts empty', () => {
    assert.strictEqual(provider.tokens(), undefined);
    assert.strictEqual(provider.clientInformation(), undefined);
    assert.strictEqual(provider.isAccessTokenStale(), true);
  });

  it('persists and reloads client information and tokens', () => {
    provider.saveClientInformation({ client_id: 'abc' });
    provider.saveTokens({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer' });

    const reloaded = new FileOAuthProvider('testserver', { baseDir });
    assert.strictEqual(reloaded.clientInformation()?.client_id, 'abc');
    assert.strictEqual(reloaded.tokens()?.access_token, 'at');
    assert.strictEqual(reloaded.tokens()?.refresh_token, 'rt');
  });

  it('reports a fresh token as not stale and an expired one as stale', () => {
    provider.saveTokens({ access_token: 'at', expires_in: 3600, token_type: 'Bearer' });
    assert.strictEqual(provider.isAccessTokenStale(), false);

    provider.saveTokens({ access_token: 'at', expires_in: 0, token_type: 'Bearer' });
    assert.strictEqual(provider.isAccessTokenStale(), true);
  });

  it('treats tokens without expiry info as usable', () => {
    provider.saveTokens({ access_token: 'at', token_type: 'Bearer' });
    assert.strictEqual(provider.isAccessTokenStale(), false);
  });

  it('persists the PKCE code verifier', () => {
    provider.saveCodeVerifier('verifier-123');
    assert.strictEqual(provider.codeVerifier(), 'verifier-123');
  });

  it('throws when no code verifier is stored', () => {
    assert.throws(() => provider.codeVerifier(), McpAuthError);
  });

  it('non-interactive provider refuses redirects with a pointer to the auth script', () => {
    assert.throws(
      () => provider.redirectToAuthorization(new URL('https://example.com/authorize')),
      /npm run auth:testserver/,
    );
  });

  it('interactive provider forwards redirects to onRedirect', () => {
    /** @type {URL | null} */
    let seen = null;
    const interactive = new FileOAuthProvider('testserver', {
      baseDir,
      redirectUrl: 'http://localhost:8976/callback',
      onRedirect: (url) => {
        seen = url;
      },
    });
    interactive.redirectToAuthorization(new URL('https://example.com/authorize'));
    assert.strictEqual(String(seen), 'https://example.com/authorize');
    assert.deepStrictEqual(interactive.clientMetadata.redirect_uris, ['http://localhost:8976/callback']);
  });

  it('clear removes all stored state', () => {
    provider.saveTokens({ access_token: 'at', token_type: 'Bearer' });
    provider.clear();
    assert.strictEqual(provider.tokens(), undefined);
  });
});
