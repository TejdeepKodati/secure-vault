# Deploying Secure Vault for $0

Secure Vault needs exactly two things a host must provide: a process that can run
`node server.js` continuously, and a **persistent disk** for `DATA_DIR` that survives a
restart or redeploy. Everything else (the PIN, the throttle, the cookie) is handled by the
app itself.

That second requirement is what rules most "free" hosting out. Read this before you pick a
provider — the app will run on the wrong one and then quietly lose your files on the first
redeploy or restart.

## Why Vercel, Netlify and most "serverless" hosts are the wrong fit

These platforms run your code in short-lived functions with **no writable persistent disk** —
anything written to disk during a request is gone once that request ends, often on a
different machine than the next one. Secure Vault stores files on disk by design (SRS 1), so
it needs a host that keeps one process running with one disk attached, not a serverless
platform. Skip Vercel, Netlify, and Cloudflare Workers/Pages for this app specifically — they're
excellent for static sites and APIs with an external database, just not for this.

What actually works is a **long-running VM** (a real Linux box that stays on) or a **PaaS
web service with a persistent volume**. Below are the two that are genuinely free with no
credit card, followed by options that are free with a catch worth knowing about.

## Option 1 — Fly.io-style PaaS with a free persistent volume: none left, honestly

As of researching this in September 2026, Railway, Render, Fly.io and Koyeb have each
either dropped their free compute tier or replaced it with a small one-time trial credit
rather than an ongoing free allowance — this changes often, so it's worth a quick check
before you commit. If you find a current free tier from one of these with a **persistent
volume** (not just free compute — you specifically need disk that survives a redeploy),
it's a good fit: push to a Git repo, set `DATA_DIR` to the mounted volume path, set
`JWT_SECRET`, done. Just confirm "persistent volume" is actually included in the free plan,
not only on paid tiers.

## Option 2 (recommended) — Oracle Cloud "Always Free" VM

This is the one genuinely free option with no time limit and no credit-based countdown, and
it's the one I'd use.

**What you get:** one or more small ARM (Ampere A1) VMs with up to 4 OCPUs / 24 GB RAM
combined (some regions have recently limited new sign-ups to 2 OCPUs / 12 GB — still far
more than this app needs), plus 200 GB of block storage and 10 TB/month of outbound
transfer. None of it expires. A card is required at signup for identity verification but is
not charged for Always-Free resources.

**The catch:** capacity for the free ARM shape is sometimes unavailable in busy regions
("out of host capacity") — retrying at a different time or region, or picking a smaller
shape, usually works. It's a real VM, so you're responsible for OS updates and a firewall,
same as any VPS.

**Steps:**
1. Sign up at oracle.com/cloud/free and create an "Always Free" Ampere A1 VM (Ubuntu 22.04+),
   smallest shape (1 OCPU / 6 GB is plenty).
2. Open port 443 (and 80, for the certificate) in both the VM's security list and its OS
   firewall (`ufw allow 80,443/tcp`).
3. Install Node 18+, `git clone` or `scp` this project, `cd` into it.
4. Put a real domain in front of it with a free reverse proxy that also gets you free HTTPS —
   [Caddy](https://caddyserver.com) is the simplest: point a domain's DNS A record at the
   VM's public IP, then a two-line Caddyfile (`your-domain.com { reverse_proxy localhost:3000 }`)
   gets you automatic HTTPS with no extra config.
5. Generate a secret and start the app as a background service:
   ```bash
   openssl rand -base64 48   # save this
   sudo tee /etc/systemd/system/secure-vault.service <<'UNIT'
   [Unit]
   Description=Secure Vault
   After=network.target

   [Service]
   WorkingDirectory=/home/ubuntu/secure-vault
   ExecStart=/usr/bin/node server.js
   Restart=always
   Environment=NODE_ENV=production
   Environment=PORT=3000
   Environment=HOST=127.0.0.1
   Environment=DATA_DIR=/home/ubuntu/secure-vault-data
   Environment=JWT_SECRET=paste-the-secret-from-above
   Environment=INITIAL_PIN=pick-a-6-digit-pin

   [Install]
   WantedBy=multi-user.target
   UNIT
   sudo systemctl enable --now secure-vault
   ```
   `HOST=127.0.0.1` and a reverse proxy in front (Caddy) is the right shape here: the proxy is
   the only thing with a public HTTPS listener, and it's also what makes `TRUST_PROXY` safe to
   turn on (`TRUST_PROXY=true`, `TRUST_PROXY_HOPS=1`) if you ever want the login throttle to see
   real client IPs instead of one shared bucket.
6. Take an occasional backup of `/home/ubuntu/secure-vault-data` — a VM is durable, not
   immortal.

No domain? Skip step 4 — you can browse straight to `http://<vm-public-ip>:3000` on the local
network, or run `sudo ufw allow 3000/tcp` and open the port directly, but then the login
cookie can't be `Secure` (no HTTPS), so keep `NODE_ENV=development` and treat it as an
internal/LAN-only deployment, not something to expose to the open internet.

## Option 3 — Google Cloud "Always Free" e2-micro

Similar shape to Oracle, smaller machine, and it's genuinely permanent (no time limit) as
long as you stay inside the free limits.

**What you get:** one `e2-micro` VM (2 shared vCPU, 1 GB RAM) with a 30 GB standard
persistent disk, but **only** in `us-west1`, `us-central1`, or `us-east1` — pick one of
those three regions or you'll be billed. A card is required at signup.

**Steps:** same shape as Oracle above — create the VM in an eligible region and zone with a
**Standard** (not Balanced or SSD) persistent disk, SSH in, install Node, follow steps 3–6
above. 1 GB of RAM is enough for this app; just don't run much else alongside it.

## Option 4 — Your own machine + Cloudflare Tunnel (free, no VM needed at all)

If you have a spare machine, a Raspberry Pi, or even a computer you leave on, you don't need
a cloud VM at all:

1. Run the app locally: `npm install --omit=dev 2>/dev/null; node server.js` (or the
   `Dockerfile`) with `DATA_DIR` on that machine's own disk — this is now the most durable
   option of all, since nothing but your own hardware can take it away.
2. Install `cloudflared` and run `cloudflared tunnel --url http://localhost:3000`, or set up
   a named tunnel with a free Cloudflare account for a stable hostname and free HTTPS — no
   port forwarding, no public IP needed.

**The catch:** the free tunnel caps request bodies at **100 MB**, so uploads larger than that
will fail with a 413 (the app's own `MAX_UPLOAD_BYTES` default is far higher — lower it to
match, e.g. `MAX_UPLOAD_BYTES=100000000`, so people get an honest error instead of a stalled
upload). It's also naturally only reachable while that machine and its connection are up.
[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) is a similar free alternative if you'd
rather not put a domain on Cloudflare's nameservers.

## Quick comparison

| | Persistent disk | Card needed | Time limit | Upload cap |
|---|---|---|---|---|
| Oracle Always Free VM | ✅ 200 GB | Yes (unverified) | None | App's own (`MAX_UPLOAD_BYTES`) |
| Google Cloud e2-micro | ✅ 30 GB | Yes (unverified) | None | App's own |
| Your own machine + Cloudflare Tunnel | ✅ Whatever you have | No | None | 100 MB (tunnel-imposed) |
| PaaS free tier (Railway/Render/Fly/Koyeb) | Varies — check for a free *volume*, not just free compute | Varies | Often trial-based | App's own |
| Vercel / Netlify / Cloudflare Workers | ❌ No writable persistent disk | No | N/A | Not usable for this app |

Whichever you pick, before calling it done: set `JWT_SECRET` (32+ random characters),
confirm `DATA_DIR` survives a reboot (reboot the VM and check your files are still there
before you rely on it), and hit `curl https://your-domain/healthz` to confirm it's up.
