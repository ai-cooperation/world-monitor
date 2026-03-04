# World Monitor APAC — Self-Hosted Deployment

## Quick Start (acmacmini2)

### 1. Clone & Install
```bash
git clone git@github.com:ai-cooperation/world-monitor.git ~/world-monitor
cd ~/world-monitor
npm install --production
```

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env with your API keys
```

### 3. Install Services
```bash
sudo cp deploy/systemd/world-monitor-api.service /etc/systemd/system/
sudo cp deploy/systemd/world-monitor-relay.service /etc/systemd/system/
sudo cp deploy/nginx/world-monitor.conf /etc/nginx/sites-available/
sudo ln -sf /etc/nginx/sites-available/world-monitor.conf /etc/nginx/sites-enabled/

sudo systemctl daemon-reload
sudo systemctl enable --now world-monitor-api world-monitor-relay
sudo systemctl restart nginx
```

### 4. Verify
```bash
curl http://127.0.0.1:3001/health
curl http://127.0.0.1:3004/health
```

## Architecture
```
Cloudflare Tunnel → localhost:80 (Nginx)
  ├── /api/*    → Express API Server (port 3001)
  ├── /relay/*  → AIS Relay (port 3004)
  └── /health   → API Server health check
```

## Resource Limits
- API Server: max 2GB RAM
- AIS Relay: max 2GB RAM, 10k vessels (reduced from 20k)
- Target total: < 6GB of 7.6GB available
