import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const ACCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;  // 90 days

export interface AuthCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod?: string;
  scopes?: string[];
  resource?: string;
  expiresAt: number;
}

interface AccessRecord {
  clientId: string;
  scopes?: string[];
  expiresAt: number;
}

interface RefreshRecord {
  clientId: string;
  scopes?: string[];
  expiresAt: number;
}

interface SerializedStore {
  v: 1;
  clients: Array<[string, OAuthClientInformationFull]>;
  access: Array<[string, AccessRecord]>;
  refresh: Array<[string, RefreshRecord]>;
  // auth codes intentionally NOT persisted — single-use, 5-min TTL,
  // restart almost certainly invalidates the in-flight code anyway
}

function rand(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export class InMemoryStore {
  private clients = new Map<string, OAuthClientInformationFull>();
  private codes = new Map<string, AuthCodeRecord>();
  private access = new Map<string, AccessRecord>();
  private refresh = new Map<string, RefreshRecord>();
  private readonly filePath?: string;

  constructor(filePath?: string) {
    this.filePath = filePath;
    if (filePath) this.load();
  }

  // ---- Persistence ----
  private load(): void {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as SerializedStore;
      if (data.v !== 1) {
        console.error(`InMemoryStore: ignoring unknown serialization version ${data.v}`);
        return;
      }
      this.clients = new Map(data.clients);
      this.access = new Map(data.access);
      this.refresh = new Map(data.refresh);
      console.error(`OAuth store loaded: ${this.clients.size} clients, ${this.access.size} access, ${this.refresh.size} refresh`);
    } catch (e) {
      console.error(`InMemoryStore: failed to load ${this.filePath}: ${(e as Error).message}`);
    }
  }

  private save(): void {
    if (!this.filePath) return;
    const data: SerializedStore = {
      v: 1,
      clients: [...this.clients.entries()],
      access: [...this.access.entries()],
      refresh: [...this.refresh.entries()],
    };
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      console.error(`InMemoryStore: failed to save ${this.filePath}: ${(e as Error).message}`);
    }
  }

  // ---- DCR ----
  async registerClient(meta: Partial<OAuthClientInformationFull>): Promise<OAuthClientInformationFull> {
    // The SDK pre-assigns client_id (UUID) before calling us; honour it if present.
    const client_id = (meta.client_id && meta.client_id.length > 0) ? meta.client_id : rand(16);
    const client: OAuthClientInformationFull = {
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...meta,
      client_id,  // always use the resolved client_id, overriding any in meta
    } as OAuthClientInformationFull;
    this.clients.set(client_id, client);
    this.save();
    return client;
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }

  // ---- Authorization codes ----
  putAuthCode(code: string, rec: AuthCodeRecord): void {
    this.codes.set(code, rec);
  }

  getAuthCode(code: string): AuthCodeRecord | undefined {
    const rec = this.codes.get(code);
    if (!rec) return undefined;
    if (Date.now() > rec.expiresAt) {
      this.codes.delete(code);
      return undefined;
    }
    return rec;
  }

  consumeAuthCode(code: string): AuthCodeRecord | undefined {
    const rec = this.getAuthCode(code);
    if (rec) this.codes.delete(code);
    return rec;
  }

  // ---- Tokens ----
  issueTokens(opts: { clientId: string; scopes?: string[] }): OAuthTokens {
    const access_token = rand();
    const refresh_token = rand();
    const now = Date.now();
    this.access.set(access_token, {
      clientId: opts.clientId,
      scopes: opts.scopes,
      expiresAt: now + ACCESS_TTL_MS,
    });
    this.refresh.set(refresh_token, {
      clientId: opts.clientId,
      scopes: opts.scopes,
      expiresAt: now + REFRESH_TTL_MS,
    });
    this.save();
    return {
      access_token,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token,
      scope: opts.scopes?.join(" "),
    };
  }

  verifyAccessToken(token: string): { clientId: string; scopes?: string[]; expiresAt: number } | undefined {
    const rec = this.access.get(token);
    if (!rec) return undefined;
    if (Date.now() > rec.expiresAt) {
      this.access.delete(token);
      this.save();
      return undefined;
    }
    return {
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.expiresAt / 1000),  // SDK expects UNIX seconds
    };
  }

  refreshTokens(refreshToken: string): OAuthTokens | undefined {
    const rec = this.refresh.get(refreshToken);
    if (!rec) return undefined;
    if (Date.now() > rec.expiresAt) {
      this.refresh.delete(refreshToken);
      this.save();
      return undefined;
    }
    // Rotate: invalidate old refresh, issue new pair (issueTokens calls save itself)
    this.refresh.delete(refreshToken);
    return this.issueTokens({ clientId: rec.clientId, scopes: rec.scopes });
  }

  revokeToken(token: string): void {
    const hadAccess = this.access.delete(token);
    const hadRefresh = this.refresh.delete(token);
    if (hadAccess || hadRefresh) this.save();
  }
}
