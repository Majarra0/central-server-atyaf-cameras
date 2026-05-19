# Central Server — Atyaf Cameras Dashboard

Arabic-language central monitoring dashboard for multiple Frigate NVR sites connected via reverse tunnels (frp).

## What this does

- Receives reverse tunnel connections from local Frigate computers (no public IP needed on site)
- Proxies all Frigate traffic through the dashboard — only **2 ports** need to be open on the server
- Three-tab Arabic UI:
  - **رفع الصور** — Upload employee face photos; pushes to the correct site's Frigate face-recognition library automatically
  - **المراقبة المباشرة** — Live camera thumbnails for all sites; "بث مباشر" opens the full Frigate UI (WebRTC/MSE) in a modal
  - **سجل الأحداث** — Browse events and download clips from any site

## Requirements

- Ubuntu/Debian VPS with a public IP
- Docker + Docker Compose
- Ports **8080** (dashboard) and **7000** (frp tunnels) open in the firewall

## Setup

### 1. Open firewall ports

```bash
sudo ufw allow 8080/tcp
sudo ufw allow 7000/tcp
sudo ufw enable
```

> On cloud providers (AWS, Hetzner, etc.) also open these in the cloud security group.

### 2. Set the tunnel secret

Edit `frp/frps.toml` and replace the token with a strong random string:

```toml
auth.token = "CHANGE_THIS_TO_A_STRONG_SECRET"
```

> Every local site's `frpc.toml` must use the **exact same token**.

### 3. Configure your sites

Edit `backend/sites.json`. Add one entry per local Frigate computer:

```json
[
  {
    "id": "site1",
    "branch": "الفرع الرئيسي",
    "frigateUrl": "http://localhost:15001",
    "cameras": ["cam1", "cam2"]
  },
  {
    "id": "site2",
    "branch": "فرع الرياض",
    "frigateUrl": "http://localhost:15002",
    "cameras": ["cam1", "cam2"]
  }
]
```

Port scheme — each site needs a unique `remotePort` in its `frpc.toml` that matches `frigateUrl` here:

| Site | frigateUrl port | frpc remotePort |
|------|----------------|-----------------|
| 1    | 15001          | 15001           |
| 2    | 15002          | 15002           |
| 3    | 15003          | 15003           |
| N    | 1500N          | 1500N           |

### 4. Start

```bash
docker compose up -d --build

# Verify
docker ps
curl http://localhost:8080/api/health
```

Open `http://YOUR_SERVER_IP:8080` in a browser. Sign in with your Frappe
username and password — the dashboard reuses the Frappe session for all
employee/company calls, and runs an initial sync automatically right after
login.

### 5. Adding a new site later

1. Add its entry to `backend/sites.json`
2. Restart the dashboard (no rebuild needed):

```bash
docker compose restart dashboard
```

## Architecture

```
Local Site A ──frpc──┐
Local Site B ──frpc──┤──► frps (port 7000)
Local Site N ──frpc──┘         │
                        Dashboard (port 8080)
                        proxies all traffic
```

## Updating

```bash
git pull
docker compose up -d --build
```
