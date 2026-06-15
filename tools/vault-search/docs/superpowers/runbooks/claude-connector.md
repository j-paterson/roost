# Claude Custom Connector — vault-search (OAuth)

> Goal: register the deployed MCP server as a Custom Connector in Claude.ai. Connect once on desktop; the connector auto-syncs to mobile.

## Steps

1. Open https://claude.ai on a desktop browser.

2. Settings → Connectors → "Add custom connector".

3. Fill in:
   - **Name:** `vault-search`
   - **MCP Server URL:** `https://<machine>.<tailnet>.ts.net/mcp`
   - **Authentication:** OAuth (Claude does Dynamic Client Registration automatically — no client_id/secret to paste).

4. Click Save / Connect. Claude will:
   - Fetch `/.well-known/oauth-authorization-server` for discovery.
   - POST to `/register` with its metadata (DCR).
   - Open a popup or new tab to `/authorize?...`.

5. The `/authorize` page asks for your **bearer token** (the value of `MCP_AUTH_TOKEN` from your NAS `.env`). Paste it. Click Approve.

6. Claude exchanges the authorization code for an access token. The connector becomes Active.

7. Confirm the four tools show up. In a new chat, ask: "What tools do you have for searching my vault?"

8. **From the mobile app:** open Claude on the phone, start a new chat, ensure the connector is enabled (it auto-syncs from the web settings). Ask:
   > "Search my vault for notes about science fiction novels. Show me the top 3."
   Expected: Claude calls `search_vault` and returns results.

## Re-authorization

You'll re-authorize whenever:
- The container restarts (in-memory token store is wiped).
- The refresh token expires (90 days).
- You revoke the token.

Re-authorization is a single click + paste: Claude prompts, you go to `/authorize`, paste the bearer, done.

## Troubleshooting

- **"OAuth error" on connect:** check `docker compose logs vault-search-mcp` on the NAS for the request. Common causes:
  - `MCP_OAUTH_ISSUER` doesn't match your Funnel HTTPS URL exactly (must include `https://`, no trailing slash).
  - `MCP_ALLOWED_HOSTS` doesn't include the Funnel hostname.
- **"Invalid token" on /authorize:** the bearer you pasted doesn't match `MCP_AUTH_TOKEN`. Check for whitespace, copy-paste truncation.
- **Connector connects but tools fail:** check container logs for the actual `/mcp` request. Often a 421 (host mismatch).

## Tool description tuning

If Claude doesn't reliably pick the right tool, edit the `description` strings in `mcp/server.ts` (the second argument to `server.tool(...)` calls), redeploy with rsync + rebuild. Description quality is the primary lever — make them specific about WHEN to use each tool.

Example improvements:
- `search_vault`: lead with "Use this whenever the user asks about content in their personal notes / Obsidian vault."
- `get_context`: "Use after `search_vault` to read the full text of a result you want to quote or cite."

## Curl-based smoke testing without OAuth

For local development or scripted testing, set `MCP_DIRECT_BEARER=1` in the env on the NAS. The OAuth flow is bypassed and `/mcp` accepts the simple `Authorization: Bearer <MCP_AUTH_TOKEN>` directly. **Never set this in production** — Claude.ai's connector won't work without OAuth.
