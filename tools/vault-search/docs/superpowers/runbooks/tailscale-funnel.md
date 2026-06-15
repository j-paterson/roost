# Tailscale Funnel Runbook

> Goal: expose the vault-search MCP container's port 3099 publicly over HTTPS via Tailscale Funnel.

## Prerequisites
- Tailscale account.
- Funnel enabled in the Tailscale admin console: ACL must include `"funnel": ["..."]` for the NAS node, OR the user must accept the Funnel prompt on first run. See https://tailscale.com/kb/1223/funnel for current setup.
- The MCP container is up on the NAS, listening on port 3099 (Phase 2 done).
- A custom DNS name is NOT required — Funnel uses your `*.ts.net` hostname.

## Steps

1. **Install Tailscale on the NAS** (host-level, not in a container)
   - Synology: Package Center → search "Tailscale" → install. Sign in.
   - Confirm: `tailscale status` shows the NAS as a node.

2. **Enable HTTPS for your tailnet** (one-time, in admin console)
   Tailscale admin → DNS → "MagicDNS" enabled, "HTTPS Certificates" enabled.

3. **Test serve before funnel**
   On the NAS:
   ```bash
   sudo tailscale serve --bg --https=443 http://localhost:3099
   sudo tailscale serve status
   ```
   From a tailnet-joined device, browse `https://<nas>.<tailnet>.ts.net/healthz`. Expect `{"status":"ok"}`.

4. **Promote to Funnel (public exposure)**
   ```bash
   sudo tailscale funnel --bg 443
   sudo tailscale funnel status
   ```

5. **Verify from a public network** (phone on cellular, NOT home wifi)
   ```bash
   curl -s https://<nas>.<tailnet>.ts.net/healthz
   ```
   Expected: `{"status":"ok"}`.

6. **Verify auth gate**
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://<nas>.<tailnet>.ts.net/mcp -X POST -H "Content-Type: application/json" -d '{}'
   ```
   Expected: `401`.

7. **Verify auth pass-through**
   Run the full Task 0.4 curl flow against `https://<nas>.<tailnet>.ts.net/mcp` with the production token.
   Expected: `tools/list` returns the four tool names.

## Operational notes
- **Bandwidth:** Funnel has [traffic limits](https://tailscale.com/kb/1223/funnel) (currently generous for personal use; check before relying on it).
- **Disable:** `sudo tailscale funnel --https=443 off` if you want to take the public surface down without removing Tailscale.
