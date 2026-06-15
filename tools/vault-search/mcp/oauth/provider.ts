import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InMemoryStore } from "./store";
import { renderConsentPage } from "./consent-page";
import { getStashedRequest } from "./request-stash";

const CODE_TTL_MS = 5 * 60 * 1000; // 5 min — RFC recommended

interface CreateProviderOptions {
  expectedBearer: string;
  store?: InMemoryStore; // injectable for tests
}

// We define OAuthProvider as a plain interface (not extending OAuthServerProvider)
// to allow the optional 4th `req` parameter on `authorize` without TS signature mismatch.
export interface OAuthProvider {
  clientsStore: OAuthRegisteredClientsStore;
  authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response, req?: Request): Promise<void>;
  challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string>;
  exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, codeVerifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens>;
  exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens>;
  verifyAccessToken(token: string): Promise<AuthInfo>;
  revokeToken?(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void>;
  skipLocalPkceValidation?: boolean;
}

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function rand(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function createOAuthProvider(opts: CreateProviderOptions): OAuthProvider {
  if (!opts.expectedBearer) {
    throw new Error("createOAuthProvider: expectedBearer required");
  }
  const store = opts.store ?? new InMemoryStore();

  const clientsStore: OAuthRegisteredClientsStore = {
    getClient: (id) => store.getClient(id),
    registerClient: (info) => store.registerClient(info),
  };

  const provider: OAuthProvider = {
    clientsStore,

    async authorize(client, params, res, req) {
      const actualReq = req ?? getStashedRequest(res);
      const submitted = (actualReq?.body as Record<string, unknown> | undefined)?.bearer_token;
      const isFormSubmit = typeof submitted === "string" && submitted.length > 0;

      if (!isFormSubmit) {
        // First visit — render consent page.
        const html = renderConsentPage({
          clientName: client.client_name ?? client.client_id,
          hiddenParams: hiddenParamsFrom(client, params),
          errorMessage: undefined,
        });
        res.set("Content-Type", "text/html; charset=utf-8");
        res.status(200).send(html);
        return;
      }

      // Form submit — validate.
      if (!constantTimeMatch(submitted as string, opts.expectedBearer)) {
        const html = renderConsentPage({
          clientName: client.client_name ?? client.client_id,
          hiddenParams: hiddenParamsFrom(client, params),
          errorMessage: "Invalid token",
        });
        res.set("Content-Type", "text/html; charset=utf-8");
        res.status(401).send(html);
        return;
      }

      // Issue authorization code, redirect to client.
      const code = rand();
      store.putAuthCode(code, {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        scopes: params.scopes,
        resource: params.resource?.toString(),
        expiresAt: Date.now() + CODE_TTL_MS,
      });

      const url = new URL(params.redirectUri);
      url.searchParams.set("code", code);
      if (params.state) url.searchParams.set("state", params.state);
      res.redirect(url.toString());
    },

    async challengeForAuthorizationCode(_client, authorizationCode) {
      const rec = store.getAuthCode(authorizationCode);
      if (!rec) throw new Error("invalid_grant: code not found or expired");
      return rec.codeChallenge;
    },

    async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, _resource) {
      const rec = store.consumeAuthCode(authorizationCode);
      if (!rec) throw new Error("invalid_grant: code not found, expired, or already used");
      if (rec.clientId !== client.client_id) throw new Error("invalid_grant: client mismatch");
      if (redirectUri && rec.redirectUri !== redirectUri) {
        throw new Error("invalid_grant: redirect_uri mismatch");
      }
      return store.issueTokens({ clientId: client.client_id, scopes: rec.scopes });
    },

    async exchangeRefreshToken(_client, refreshToken, _scopes, _resource) {
      const tokens = store.refreshTokens(refreshToken);
      if (!tokens) throw new Error("invalid_grant: refresh token invalid or expired");
      return tokens;
    },

    async verifyAccessToken(token) {
      const rec = store.verifyAccessToken(token);
      if (!rec) throw new InvalidTokenError("invalid_token");
      const info: AuthInfo = {
        token,
        clientId: rec.clientId,
        scopes: rec.scopes ?? [],
        expiresAt: rec.expiresAt,
      };
      return info;
    },

    async revokeToken(_client, request: OAuthTokenRevocationRequest) {
      store.revokeToken(request.token);
    },
  };

  return provider;
}

function hiddenParamsFrom(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
): Record<string, string> {
  // The form posts back to /authorize. The SDK re-validates EVERY OAuth param
  // on the POST, so we must round-trip all of them — including client_id,
  // response_type, and code_challenge_method which aren't in AuthorizationParams.
  const out: Record<string, string> = {
    client_id: client.client_id,
    response_type: "code",
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: params.redirectUri,
  };
  if (params.state) out.state = params.state;
  if (params.scopes) out.scope = params.scopes.join(" ");
  if (params.resource) out.resource = params.resource.toString();
  return out;
}
