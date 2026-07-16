import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { auth } from '@modelcontextprotocol/sdk/client/auth.js';

/**
 * OAuth 2.1 (PKCE + dynamic client registration) for the external MCP
 * servers, built on the MCP SDK's client auth helpers.
 *
 * Flow: a human runs `npm run auth:clickup` / `npm run auth:fireflies` once —
 * the script walks the browser authorization flow and persists tokens here.
 * At runtime everything is headless: access tokens are read from disk and
 * refreshed automatically via the refresh token; if authorization is missing
 * the server simply doesn't attach (agent) or fails with a clear pointer to
 * the auth script (executor).
 */

/**
 * Token store location. MCP_AUTH_DIR overrides (tests point this at an empty
 * directory so they can never pick up real tokens and hit live servers).
 * @returns {string}
 */
function defaultBaseDir() {
  return process.env.MCP_AUTH_DIR || './data/mcp-auth';
}

/** Refresh when the access token has less than this long to live. */
const EXPIRY_SLACK_MS = 60 * 1000;

export class McpAuthError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'McpAuthError';
  }
}

/** @typedef {import('@modelcontextprotocol/sdk/client/auth.js').OAuthClientProvider} OAuthClientProvider */

/**
 * File-backed implementation of the MCP SDK's OAuthClientProvider.
 * One JSON file per server under data/mcp-auth/ (gitignored).
 *
 * @implements {OAuthClientProvider}
 */
export class FileOAuthProvider {
  /**
   * @param {string} serverKey - e.g. 'clickup' or 'fireflies'.
   * @param {{ baseDir?: string, redirectUrl?: string, onRedirect?: (url: URL) => void }} [options]
   *   `onRedirect` makes the provider interactive (authorize script); without
   *   it, an authorization redirect throws with instructions instead.
   */
  constructor(serverKey, options = {}) {
    /** @private */
    this._serverKey = serverKey;
    /** @private */
    this._path = join(options.baseDir || defaultBaseDir(), `${serverKey}.json`);
    /** @private */
    this._redirectUrl = options.redirectUrl;
    /** @private */
    this._onRedirect = options.onRedirect;
  }

  /** @private @returns {any} */
  _read() {
    try {
      return JSON.parse(readFileSync(this._path, 'utf8'));
    } catch {
      return {};
    }
  }

  /** @private @param {any} data @returns {void} */
  _write(data) {
    mkdirSync(dirname(this._path), { recursive: true });
    writeFileSync(this._path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  }

  get redirectUrl() {
    return this._redirectUrl;
  }

  get clientMetadata() {
    return {
      client_name: 'Pixelup Bot',
      redirect_uris: this._redirectUrl ? [this._redirectUrl] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  clientInformation() {
    return this._read().client_information;
  }

  /** @param {any} clientInformation @returns {void} */
  saveClientInformation(clientInformation) {
    this._write({ ...this._read(), client_information: clientInformation });
  }

  tokens() {
    return this._read().tokens;
  }

  /** @param {any} tokens @returns {void} */
  saveTokens(tokens) {
    this._write({ ...this._read(), tokens, tokens_obtained_at: Date.now() });
  }

  /**
   * True when the stored access token is missing or about to expire.
   * @returns {boolean}
   */
  isAccessTokenStale() {
    const data = this._read();
    if (!data.tokens?.access_token) return true;
    if (typeof data.tokens.expires_in !== 'number' || !data.tokens_obtained_at) return false;
    const expiresAt = data.tokens_obtained_at + data.tokens.expires_in * 1000;
    return Date.now() > expiresAt - EXPIRY_SLACK_MS;
  }

  /** @param {URL} authorizationUrl @returns {void} */
  redirectToAuthorization(authorizationUrl) {
    if (this._onRedirect) {
      this._onRedirect(authorizationUrl);
      return;
    }
    throw new McpAuthError(
      `${this._serverKey} MCP requires authorization — run \`npm run auth:${this._serverKey}\` once to sign in.`,
    );
  }

  /** @param {string} codeVerifier @returns {void} */
  saveCodeVerifier(codeVerifier) {
    this._write({ ...this._read(), code_verifier: codeVerifier });
  }

  /** @returns {string} */
  codeVerifier() {
    const verifier = this._read().code_verifier;
    if (!verifier) throw new McpAuthError(`No code verifier stored for ${this._serverKey}.`);
    return verifier;
  }

  /** Remove all stored auth state for this server. @returns {void} */
  clear() {
    rmSync(this._path, { force: true });
  }
}

/**
 * Headless access-token lookup for a server: returns a fresh access token
 * from the store (refreshing via the refresh token when stale), or null when
 * the server was never authorized — callers then skip attaching the server.
 * @param {{ key: string }} server
 * @param {string} serverUrl
 * @param {{ baseDir?: string }} [options]
 * @returns {Promise<string | null>}
 */
export async function getOAuthAccessToken(server, serverUrl, options = {}) {
  const provider = new FileOAuthProvider(server.key, options);
  const tokens = provider.tokens();
  if (!tokens?.access_token) return null;

  if (provider.isAccessTokenStale() && tokens.refresh_token) {
    try {
      // With a refresh token present this refreshes headlessly; it only
      // redirects (throws McpAuthError) when re-authorization is unavoidable.
      await auth(provider, { serverUrl });
    } catch {
      return null;
    }
  }

  return provider.tokens()?.access_token ?? null;
}
