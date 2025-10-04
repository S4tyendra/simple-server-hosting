# 🐳 Docker Manager Dashboard

A slick web-based dashboard for managing Docker containers pulled from GitHub Container Registry (GHCR). Built with Hono + Bun for maximum speed, with automatic Nginx configuration, environment management, and real-time container monitoring.

Perfect for managing your self-hosted infrastructure on IIIT Kota servers (or any Ubuntu/Debian box really).

---
> [!WARNING]
>  This repo is highly customized to use with iiitkota servers and infra structure. if you want to use for your apps, please change domain and folder names.
## ✨ Features

→ **GHCR Integration**: Auto-discover and pull images from `web-iiitkota` organization  
→ **Docker Compose Automation**: Generate and manage compose files with resource limits  
→ **Nginx Auto-Config**: Set up reverse proxy mappings with custom domains (`.iiitkota.ac.in`)  
→ **Environment Management**: Edit `.env` files directly from the UI  
→ **Real-time Logs**: Stream container logs with live updates  
→ **Resource Control**: Set CPU/memory limits, restart policies, port mappings  
→ **Update Detection**: Shows when newer image versions are available  
→ **Beautiful UI**: Dark/light theme with glassmorphic cards and smooth animations

---

## 📋 Prerequisites

- **OS**: Ubuntu/Debian (tested on Ubuntu Server)
- **Runtime**: [Bun](https://bun.sh) (for running the app)
- **Docker**: Docker Engine + Docker Compose v2
- **Nginx**: For reverse proxy (optional but recommended)
- **Sudo Access**: Required for Nginx reloads and container management

---

## 🚀 Installation

### 1️⃣ Install Bun
```bash
curl -fsSL https://bun.sh/install | bash
```

### 2️⃣ Clone the Repo
```bash
git clone https://github.com/s4tyendra/simple-server-hosting.git
cd simple-server-hosting
git checkout docker  # Switch to docker branch
```

### 3️⃣ Install Dependencies
```bash
bun install
```

### 4️⃣ Set Environment Variables
Create a `.env` file or export these:

```bash
export GITHUB_PAT="ghp_your_github_personal_access_token"
export AUTH_USERNAME="admin"
export AUTH_PASSWORD="your_secure_password"
export PORT="8080"
```

**Getting a GitHub PAT:**
1. Go to GitHub → Settings → Developer Settings → Personal Access Tokens
2. Generate a new token (classic) with `read:packages` scope
3. Copy and use it as `GITHUB_PAT`

---

## 🏃 Running the App

### Development Mode
```bash
bun run index.ts
```

### Production Mode (with sudo for Nginx control)
```bash
sudo -E bun run index.ts
# The -E flag preserves environment variables
```

Or use a process manager like PM2:
```bash
sudo pm2 start index.ts --interpreter bun --name docker-manager
```

Access at: `http://localhost:8080` (or your configured port)

---

## ⚙️ Nginx Setup (Optional but Recommended)

The app can automatically manage Nginx configs for your containers. Here's the base setup:

### 1️⃣ Create the main config file
```bash
sudo nano /etc/nginx/sites-available/iiit-apis
```

Add this base config:
```nginx
# This file is managed by Docker Manager
# Individual server blocks are auto-generated

# Include SSL certificate config
# (Assuming you have SSL set up with Let's Encrypt or similar)
```

### 2️⃣ Enable it
```bash
sudo ln -s /etc/nginx/sites-available/iiit-apis /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 3️⃣ Give the app write permissions
```bash
sudo chown $USER:$USER /etc/nginx/sites-available/iiit-apis
```

Or run the app with sudo (it needs sudo for `nginx -t` and `systemctl reload nginx` anyway).

---

## 🎯 Usage Guide

### Creating a New Container

1. **Pull/Update Image**: Click "🔄 Update/Pull" to fetch the latest image from GHCR
2. **Configure Settings**: 
   - Set **Host Port** (external) and **Container Port** (internal)
   - Add **Environment Variables** (format: `KEY=value`)
   - Set **Resource Limits** (CPU, Memory)
   - Configure **Restart Policy**
3. **Optional - Add Domain**: 
   - Enter a subdomain (e.g., `api`) to get `api.iiitkota.ac.in`
   - Set **Client Max Body Size** for uploads
4. **Start Container**: Click "🚀 Start" to create and run the container

### Managing Running Containers

- **🔄 Restart**: Restart the container
- **⏹️ Stop**: Stop the container (doesn't remove it)
- **📄 Logs**: View real-time container logs
- **🗑️ Remove**: Delete the container (image stays)

### Updating Containers

1. Pull the new image version (it'll show "update_available" status)
2. Open **Environment & Configuration** section
3. Click **💾 Save & Recreate Container**
4. This stops, removes, and recreates the container with new image + settings

### Editing Nginx Directly

Click **⚡ Nginx** button → Edit the config → **💾 Save, Test & Reload**

The app will:
1. Backup the old config
2. Write your changes
3. Run `sudo nginx -t` to test
4. Reload Nginx if test passes
5. Restore backup if test fails

---

## 📁 Project Structure

```
~/.dckr/
└── env/
    └── <service-name>/
        ├── .env                    # Environment variables
        ├── config.json             # Resource limits & settings
        └── docker-compose.yml      # Auto-generated compose file
```

---

## 🔐 Security Notes

⚠️ **This app requires sudo access** for:
- Nginx testing and reloading
- Docker operations (if not in docker group)

🛡️ Recommendations:
- Use strong passwords for basic auth
- Keep `GITHUB_PAT` secure (read-only scope)
- Run behind a firewall (only expose port 443 publicly)
- Use SSL/TLS in production (Let's Encrypt)
- Restrict `~/.dckr/env/` directory permissions

---

## 🐛 Troubleshooting

### "Permission denied" when managing containers
→ Add your user to the docker group:
```bash
sudo usermod -aG docker $USER
newgrp docker
```

### Nginx test fails but config looks correct
→ Check for duplicate `server_name` directives:
```bash
sudo nginx -T | grep server_name
```

### Container won't start
→ Check logs in the UI or via:
```bash
docker logs <container-name>
```

### Domain not resolving
→ Verify DNS A record points to your server IP:
```bash
dig +short subdomain.iiitkota.ac.in
```

---

## 🤝 Contributing

Found a bug? Want a feature? PRs are welcome!

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/cool-thing`)
3. Commit changes (`git commit -m 'Add cool thing'`)
4. Push to branch (`git push origin feature/cool-thing`)
5. Open a PR

---

## 📝 License

MIT License - do whatever you want with it!

---

## 💬 Support

Issues? Questions? Open an issue on GitHub or reach out at [satya@satyendra.in](mailto:satya@satyendra.in)

Built with 💙 for IIIT Kota infrastructure by [@s4tyendra](https://github.com/s4tyendra)