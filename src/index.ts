import { Hono } from 'hono'
import { basicAuth } from 'hono/basic-auth'
import { serveStatic } from 'hono/bun'
import Docker from 'dockerode'
import { stream } from 'hono/streaming'
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// --- Interfaces ---
interface GitHubPackage {
  id: number
  name: string
}

interface GitHubVersion {
  id: number
  name: string
  created_at: string
  metadata: {
    container: {
      tags: string[]
    }
  }
}

interface NginxServerConfig {
    server_name: string
    proxy_pass_port: string
    client_max_body_size: string
    raw_block: string
}

interface ImageInfo {
  name: string
  localTag: string
  remoteTag: string
  localImageId: string
  containerId: string
  containerName: string
  status: string
  localCreated: string
  remoteCreated: string
  size: string
  envVars: Record<string, string>
  config: ResourceLimits
  nginx: {
    domain?: string
    clientMaxBodySize?: string
  }
}

interface ResourceLimits {
  cpuLimit?: string
  memoryLimit?: string
  hostPort?: string
  containerPort?: string
  restartPolicy?: string
  domain?: string // Added for consistency
  clientMaxBodySize?: string // Added for consistency
}


// --- Configuration ---
const ENV_BASE_DIR = join(homedir(), '.dckr', 'env')
const NGINX_CONFIG_PATH = '/etc/nginx/sites-available/iiit-apis'
const BACKUP_DIR = './backups'
const BASE_DOMAIN = 'iiitkota.ac.in'

// Create backup directory on startup
if (!existsSync(BACKUP_DIR)) {
  mkdirSync(BACKUP_DIR, { recursive: true })
}


// Load environment variables
const GITHUB_PAT = process.env.GITHUB_PAT || Bun.env.GITHUB_PAT
const AUTH_USERNAME = process.env.AUTH_USERNAME || Bun.env.AUTH_USERNAME || '123'
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || Bun.env.AUTH_PASSWORD || '123'
const PORT = process.env.PORT || Bun.env.PORT || '8080'

if (!GITHUB_PAT) {
  console.error('GITHUB_PAT environment variable is required')
  process.exit(1)
}

// --- Nginx Management Functions ---
function parseNginxConfig(content: string): NginxServerConfig[] {
    const servers: NginxServerConfig[] = []
    // Use a non-greedy match for the content inside server block
    const serverRegex = /server\s*\{[\s\S]*?\}/g
    const serverNameRegex = /server_name\s+([^;]+);/
    const proxyPassRegex = /proxy_pass\s+http:\/\/localhost:(\d+);/
    const clientMaxBodyRegex = /client_max_body_size\s+([^;]+);/

    const matches = content.match(serverRegex) || []

    for (const block of matches) {
        const serverNameMatch = block.match(serverNameRegex)
        const proxyPassMatch = block.match(proxyPassRegex)
        const clientMaxBodyMatch = block.match(clientMaxBodyRegex)

        if (serverNameMatch && proxyPassMatch) {
            servers.push({
                server_name: serverNameMatch[1].trim(),
                proxy_pass_port: proxyPassMatch[1].trim(),
                client_max_body_size: clientMaxBodyMatch ? clientMaxBodyMatch[1].trim() : 'N/A',
                raw_block: block,
            })
        }
    }
    return servers
}

function createNginxServerBlock(subdomain: string, port: string, clientMaxBodySize: string): string {
    const serverName = `${subdomain}.${BASE_DOMAIN}`
    return `
# Service: ${serverName}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${serverName};

    include snippets/ssl-cname-iiitkota.conf;
    client_max_body_size ${clientMaxBodySize};

    brotli on;
    brotli_comp_level 6;
    brotli_types text/plain text/css application/json application/javascript application/x-javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;

    if ($http_upgrade = "websocket") {
        return 403;
    }

    location / {
        proxy_pass http://localhost:${port};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}`
}

// --- File & Directory Management ---
function ensureEnvDir(imageName: string): string {
  const envDir = join(ENV_BASE_DIR, imageName)
  if (!existsSync(envDir)) {
    mkdirSync(envDir, { recursive: true })
  }
  return envDir
}

function getEnvFilePath(imageName: string): string {
  const envFile = join(ensureEnvDir(imageName), '.env')
  if (!existsSync(envFile)) {
    try {
      writeFileSync(envFile, '', { flag: 'wx' })
    } catch { /* ignore */ }
  }
  return envFile
}

function readEnvFile(imageName: string): Record<string, string> {
  const envPath = getEnvFilePath(imageName)
  const env: Record<string, string> = {}
  try {
    const content = readFileSync(envPath, 'utf-8')
    content.split('\n').forEach(line => {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...valueParts] = trimmed.split('=')
        env[key.trim()] = valueParts.join('=').trim()
      }
    })
  } catch (error) {
    console.error(`Error reading env file for ${imageName}:`, error)
  }
  return env
}

function writeEnvFile(imageName: string, envVars: Record<string, string>): void {
  const envPath = getEnvFilePath(imageName)
  const content = Object.entries(envVars)
    .filter(([key, value]) => key.trim() && value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
  try {
    writeFileSync(envPath, content, 'utf-8')
  } catch (error) {
    console.error(`Error writing env file for ${imageName}:`, error)
    throw error
  }
}

function createDockerComposeContent(imageName: string, tag: string, config: ResourceLimits): string {
  const envPath = getEnvFilePath(imageName)
  const portMapping = `${config.hostPort || '8080'}:${config.containerPort || '8080'}`
  return `version: '3.8'

services:
  ${imageName}:
    image: ghcr.io/web-iiitkota/${imageName}:${tag}
    container_name: ${imageName}
    restart: ${config.restartPolicy || 'unless-stopped'}
    ports:
      - "${portMapping}"
    env_file:
      - ${envPath}
    deploy:
      resources:
        limits:
          cpus: '${config.cpuLimit || '0.5'}'
          memory: ${config.memoryLimit || '512M'}
        reservations:
          cpus: '0.1'
          memory: 64M
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:${config.containerPort || '8080'}/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    labels:
      - "com.docker.compose.service=${imageName}"

networks:
  default:
    driver: bridge
`
}

// --- Hono App & Docker Initialization ---
const app = new Hono()
const docker = new Docker()

const dockerAuthConfig = {
  username: 'web-iiitkota',
  password: GITHUB_PAT,
  serveraddress: 'ghcr.io'
}

// --- Middleware ---
app.use('/*', basicAuth({ username: AUTH_USERNAME, password: AUTH_PASSWORD }))
app.use('/static/*', serveStatic({ root: './' }))

// --- GitHub API Functions ---
async function getGitHubPackages(): Promise<GitHubPackage[]> {
  const response = await fetch('https://api.github.com/users/web-iiitkota/packages?package_type=container', {
    headers: { 'Authorization': `Bearer ${GITHUB_PAT}`, 'Accept': 'application/vnd.github+json' }
  })
  if (!response.ok) throw new Error(`GitHub API error (Packages): ${response.status}`)
  return response.json() as Promise<GitHubPackage[]>
}

async function getPackageVersions(packageName: string): Promise<GitHubVersion[]> {
  const response = await fetch(`https://api.github.com/users/web-iiitkota/packages/container/${packageName}/versions`, {
    headers: { 'Authorization': `Bearer ${GITHUB_PAT}`, 'Accept': 'application/vnd.github+json' }
  })
  if (!response.ok) throw new Error(`GitHub API error (Versions): ${response.status}`)
  return response.json() as Promise<GitHubVersion[]>
}

// --- Helper Functions ---
function getLatestTag(versions: GitHubVersion[]): string {
  const tags = versions.flatMap(v => v.metadata.container.tags.filter(tag => /^\d{4}$/.test(tag)))
  if (tags.length === 0) return ''
  return tags.sort().pop() || ''
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

function getDefaultConfig(serviceName: string): ResourceLimits {
  return {
    cpuLimit: '0.2',
    memoryLimit: '216M',
    hostPort: undefined, 
    containerPort: '3000',
    restartPolicy: 'unless-stopped',
    clientMaxBodySize: '10M'
  }
}

// --- Core Docker & Data Aggregation Logic ---
async function getImageInfo(): Promise<{ images: ImageInfo[], nginxConfig: NginxServerConfig[] }> {
  try {
    const [packages, localImages, containers] = await Promise.all([
      getGitHubPackages(),
      docker.listImages(),
      docker.listContainers({ all: true })
    ])
    
    let nginxConfig: NginxServerConfig[] = [];
    try {
        if (existsSync(NGINX_CONFIG_PATH)) {
            const nginxContent = readFileSync(NGINX_CONFIG_PATH, 'utf-8');
            nginxConfig = parseNginxConfig(nginxContent);
        }
    } catch (e) {
        console.warn("Could not read or parse Nginx config:", e.message);
    }
    const portToNginxMap = new Map(nginxConfig.map(c => [c.proxy_pass_port, c]));

    const imagesInfo: ImageInfo[] = []

    for (const pkg of packages) {
      const versions = await getPackageVersions(pkg.name)
      const latestTag = getLatestTag(versions)
      if (!latestTag) continue

      const imageBaseName = `ghcr.io/web-iiitkota/${pkg.name}`
      
      const configPath = join(ensureEnvDir(pkg.name), 'config.json')
      let savedConfig: Partial<ResourceLimits> = {};
      if (existsSync(configPath)) {
          try {
              savedConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
          } catch { /* ignore parse error */ }
      }

      const info: ImageInfo = {
        name: pkg.name,
        localTag: '',
        remoteTag: latestTag,
        localImageId: '',
        containerId: '',
        containerName: '',
        status: 'not_pulled',
        localCreated: '',
        remoteCreated: '',
        size: '',
        envVars: readEnvFile(pkg.name),
        config: { ...getDefaultConfig(pkg.name), ...savedConfig },
        nginx: {}
      }

      const localImage = localImages.find(img => img.RepoTags?.some(tag => tag.startsWith(`${imageBaseName}:`)))
      if (localImage) {
        const allLocalRepoTags = localImage.RepoTags?.filter(tag => tag.startsWith(`${imageBaseName}:`)) || [];
        const numericLocalTags = allLocalRepoTags
          .map(tag => tag.split(':').pop() || '')
          .filter(tag => /^\d{4}$/.test(tag));

        if (numericLocalTags.length > 0) {
          info.localTag = numericLocalTags.sort().pop()!;
        } else if (allLocalRepoTags.length > 0) {
          info.localTag = allLocalRepoTags[0].split(':').pop() || '?';
        }

        info.localImageId = localImage.Id.slice(7, 19)
        info.localCreated = new Date(localImage.Created * 1000).toLocaleString()
        info.size = formatSize(localImage.Size || 0)
        info.status = info.localTag === latestTag ? 'up_to_date' : 'update_available'
      }

      const container = containers.find(c => c.ImageID === localImage?.Id || c.Names[0]?.replace(/^\//, '') === pkg.name)
      if (container) {
        info.containerId = container.Id.slice(0, 12)
        info.containerName = container.Names[0]?.replace(/^\//, '') || ''
        if (container.State === 'running') {
          info.status = info.status === 'up_to_date' ? 'running' : 'running_outdated'
        } else {
          info.status = info.status === 'up_to_date' ? 'stopped' : 'stopped_outdated'
        }

        try {
          const containerInstance = docker.getContainer(container.Id);
          const inspectData = await containerInstance.inspect();
          const portBindings = inspectData.HostConfig.PortBindings;
          for (const containerPort in portBindings) {
              if (portBindings[containerPort] && portBindings[containerPort].length > 0) {
                  info.config.hostPort = portBindings[containerPort][0].HostPort;
                  info.config.containerPort = containerPort.split('/')[0];
                  break; 
              }
          }
          info.config.restartPolicy = inspectData.HostConfig.RestartPolicy.Name;
        } catch (inspectError) {
          console.warn(`Could not inspect container ${container.Id}:`, inspectError);
        }
      }
      
      const remoteVersion = versions.find(v => v.metadata.container.tags.includes(latestTag))
      if (remoteVersion) {
        info.remoteCreated = new Date(remoteVersion.created_at).toLocaleString()
      }
      
      const nginxMapping = info.config.hostPort ? portToNginxMap.get(info.config.hostPort) : undefined;
      if (nginxMapping) {
        info.nginx.domain = nginxMapping.server_name.replace(`.${BASE_DOMAIN}`, '');
        info.nginx.clientMaxBodySize = nginxMapping.client_max_body_size;
        // Sync config with what's actually in nginx
        info.config.domain = info.nginx.domain;
        info.config.clientMaxBodySize = info.nginx.clientMaxBodySize;
      }


      imagesInfo.push(info)
    }
    return { images: imagesInfo, nginxConfig: nginxConfig };
  } catch (error) {
    console.error('Error getting image info:', error)
    throw error
  }
}

// --- HTML Template & Main Route ---
const htmlTemplate = `
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>🐳 Docker Manager</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
      :root {
        --font-family: 'Inter', sans-serif;
        --border-radius: 0.75rem;
        --transition-speed: 0.3s;
        --pico-spacing: 1.5rem;

        /* Light Theme */
        --bg-color-light: #f3f4f6;
        --card-bg-light: rgba(255, 255, 255, 0.5);
        --text-color-light: #1f2937;
        --heading-color-light: #111827;
        --border-color-light: rgba(209, 213, 219, 0.6);
        --shadow-color-light: rgba(0, 0, 0, 0.05);
        --primary-light: #3b82f6;
        --primary-hover-light: #2563eb;
        --contrast-light: #ef4444;
        --contrast-hover-light: #dc2626;

        /* Dark Theme */
        --bg-color-dark: #111827;
        --card-bg-dark: rgba(31, 41, 55, 0.5);
        --text-color-dark: #d1d5db;
        --heading-color-dark: #f9fafb;
        --border-color-dark: rgba(75, 85, 99, 0.6);
        --shadow-color-dark: rgba(0, 0, 0, 0.2);
        --primary-dark: #60a5fa;
        --primary-hover-dark: #3b82f6;
        --contrast-dark: #f87171;
        --contrast-hover-dark: #ef4444;

        /* Status Colors */
        --green: #2ecc71; --red: #e74c3c; --orange: #f39c12; --grey: #95a5a6;
      }

      [data-theme="light"] {
        --bg-color: var(--bg-color-light);
        --card-bg: var(--card-bg-light);
        --text-color: var(--text-color-light);
        --heading-color: var(--heading-color-light);
        --border-color: var(--border-color-light);
        --shadow-color: var(--shadow-color-light);
        --primary: var(--primary-light);
        --primary-hover: var(--primary-hover-light);
        --contrast: var(--contrast-light);
        --contrast-hover: var(--contrast-hover-light);
      }

      [data-theme="dark"] {
        --bg-color: var(--bg-color-dark);
        --card-bg: var(--card-bg-dark);
        --text-color: var(--text-color-dark);
        --heading-color: var(--heading-color-dark);
        --border-color: var(--border-color-dark);
        --shadow-color: var(--shadow-color-dark);
        --primary: var(--primary-dark);
        --primary-hover: var(--primary-hover-dark);
        --contrast: var(--contrast-dark);
        --contrast-hover: var(--contrast-hover-dark);
      }

      *, *::before, *::after { box-sizing: border-box; }

      body {
        font-family: var(--font-family);
        background-color: var(--bg-color);
        color: var(--text-color);
        margin: 0;
        min-height: 100vh;
        overflow-x: hidden;
        position: relative;
        transition: background-color var(--transition-speed) ease, color var(--transition-speed) ease;
      }

      body::before, body::after {
        content: '';
        position: fixed;
        z-index: -1;
        border-radius: 50%;
        filter: blur(100px);
        opacity: 0.5;
      }

      body::before {
        width: 400px;
        height: 400px;
        background: linear-gradient(90deg, #3b82f6, #9333ea);
        top: -10%;
        left: -10%;
        animation: move-blob-1 20s infinite alternate;
      }

      body::after {
        width: 500px;
        height: 500px;
        background: linear-gradient(90deg, #f59e0b, #ef4444);
        bottom: -15%;
        right: -15%;
        animation: move-blob-2 25s infinite alternate;
      }

      @keyframes move-blob-1 {
        from { transform: translate(0, 0) scale(1); }
        to { transform: translate(100px, 50px) scale(1.2); }
      }
      @keyframes move-blob-2 {
        from { transform: translate(0, 0) scale(1); }
        to { transform: translate(-80px, -60px) scale(0.8); }
      }

      .container { max-width: 1280px; margin: 0 auto; padding: var(--pico-spacing); }
      
      header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding-bottom: var(--pico-spacing);
      }
      header hgroup { margin: 0; }
      header h1 { font-size: 2.25rem; color: var(--heading-color); margin: 0;}
      header h2 { font-size: 1.125rem; color: var(--text-color); margin: 0; opacity: 0.8;}
      header nav { display: flex; align-items: center; gap: 1rem; }

      button, a[role="button"] {
        font-family: var(--font-family);
        font-weight: 600;
        border: none;
        border-radius: var(--border-radius);
        padding: 0.75rem 1.5rem;
        cursor: pointer;
        transition: all var(--transition-speed) ease;
        box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1);
        background-color: var(--primary);
        color: white;
      }
      button:hover, a[role="button"]:hover {
        background-color: var(--primary-hover);
        transform: translateY(-2px);
        box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1);
      }
      button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
      button.contrast { background-color: var(--contrast); }
      button.contrast:hover { background-color: var(--contrast-hover); }
      button.secondary { background-color: var(--card-bg); color: var(--text-color); border: 1px solid var(--border-color); }
      button.secondary:hover { background-color: var(--border-color); }
      button.outline { background-color: transparent; border: 1px solid var(--border-color); color: var(--text-color); box-shadow: none; }
      button.outline:hover { background-color: var(--border-color); }
      button[aria-busy='true']::before { width: 1em; height: 1em; }

      details[role="list"] { position: relative; margin: 0; }
      details[role="list"] summary { list-style: none; cursor: pointer; padding: 0.75rem 1.5rem; border-radius: var(--border-radius); border: 1px solid var(--border-color); background-color: var(--card-bg); transition: background-color var(--transition-speed) ease; }
      details[role="list"] summary:hover { background-color: var(--border-color); }
      details[role="list"] ul { position: absolute; right: 0; top: calc(100% + 0.5rem); background-color: var(--card-bg); border: 1px solid var(--border-color); border-radius: var(--border-radius); padding: 0.5rem; margin: 0; list-style: none; min-width: 150px; z-index: 10; backdrop-filter: blur(10px); }
      details[role="list"] ul a { display: block; padding: 0.5rem 1rem; border-radius: 0.5rem; text-decoration: none; color: var(--text-color); transition: background-color var(--transition-speed) ease; }
      details[role="list"] ul a:hover { background-color: var(--border-color); }

      .image-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: var(--pico-spacing); }
      
      article, .card {
        background: var(--card-bg);
        border: 1px solid var(--border-color);
        border-radius: 1rem;
        padding: var(--pico-spacing);
        box-shadow: 0 8px 32px 0 var(--shadow-color);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        transition: transform var(--transition-speed) ease, box-shadow var(--transition-speed) ease;
      }
      article:hover { transform: translateY(-5px); box-shadow: 0 12px 40px 0 var(--shadow-color); }

      article header { padding: 0; flex-direction: column; align-items: flex-start; }
      article hgroup { margin-bottom: 1rem; }
      article h3 { margin: 0 0 0.5rem 0; font-size: 1.5rem; color: var(--heading-color); }
      
      .status { display: inline-block; padding: 0.35rem 0.75rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; line-height: 1; color: #fff; text-align: center; white-space: nowrap; vertical-align: baseline; text-transform: capitalize; }
      .status.running, .status.up_to_date { background-color: var(--green); }
      .status.stopped { background-color: var(--orange); }
      .status.not_pulled { background-color: var(--grey); }
      .status.update_available, .status.running_outdated, .status.stopped_outdated { background-color: var(--red); }
      
      .flex { display: grid; grid-template-columns: 1fr 200px; gap: var(--pico-spacing); }
      .details p { margin: 0 0 0.75rem; font-size: 0.9em; display: flex; justify-content: space-between;}
      .details strong { color: var(--heading-color); }
      .details code { background-color: var(--border-color); padding: 0.15rem 0.4rem; border-radius: 0.25rem; font-size: 0.9em; word-break: break-all; }
      .actions { display: flex; flex-direction: column; gap: 0.75rem; }
      .actions .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
      .actions button { width: 100%; padding: 0.5rem; font-size: 0.875rem; }
      
      article footer { margin-top: var(--pico-spacing); padding-top: var(--pico-spacing); border-top: 1px solid var(--border-color); font-size: 0.8em; opacity: 0.7; }

      label { font-weight: 500; font-size: 0.875rem; margin-bottom: 0.5rem; display: block; }
      textarea, input[type="text"], select { width: 100%; background: var(--border-color); border: 1px solid transparent; border-radius: 0.5rem; padding: 0.75rem; color: var(--text-color); font-family: var(--font-family); transition: border-color var(--transition-speed) ease; }
      textarea:focus, input[type="text"]:focus, select:focus { border-color: var(--primary); outline: none; }
      
      details > summary { list-style: none; cursor: pointer; padding: 0.5rem 1rem; border-radius: 0.5rem; background: var(--border-color); margin-bottom: 0.5rem; font-weight: 500; transition: background-color var(--transition-speed) ease; }
      details > summary:hover { background-color: var(--card-bg); }
      details .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
      .input-group { display: flex; align-items: center; }
      .input-group input { border-radius: 0.5rem 0 0 0.5rem; }
      .input-group span { background: var(--border-color); padding: 0.75rem; border-radius: 0 0.5rem 0.5rem 0; font-size: 0.9em; opacity: 0.8; }


      .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; backdrop-filter: blur(5px); opacity: 0; transition: opacity var(--transition-speed) ease; }
      .modal-overlay[style*="display: flex;"] { opacity: 1; }
      .modal-content { width: 90%; max-width: 800px; max-height: 90vh; display: flex; flex-direction: column; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 1rem; box-shadow: 0 8px 32px 0 var(--shadow-color); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); transform: scale(0.95); transition: transform var(--transition-speed) ease; }
      .modal-overlay[style*="display: flex;"] .modal-content { transform: scale(1); }
      .modal-content header { display: flex; justify-content: space-between; align-items: center; padding: var(--pico-spacing); border-bottom: 1px solid var(--border-color); }
      .modal-content header h2 { margin: 0; font-size: 1.25rem; }
      a.close { text-decoration: none; font-size: 1.5rem; color: var(--text-color); opacity: 0.7; transition: opacity var(--transition-speed) ease; }
      a.close:hover { opacity: 1; }
      a.close::before { content: '✕'; }
      .modal-body { overflow-y: auto; flex-grow: 1; padding: var(--pico-spacing); }
      .modal-body pre, .modal-body textarea { height: 400px; margin: 0; background: rgba(0,0,0,0.2); padding: 1rem; border-radius: var(--border-radius); color: var(--text-color); white-space: pre-wrap; word-wrap: break-word; font-family: monospace; }
      .modal-content footer { padding: var(--pico-spacing); border-top: 1px solid var(--border-color); text-align: right; display: flex; justify-content: flex-end; gap: 1rem;}

      .toast { position: fixed; top: 20px; right: 20px; padding: 1rem 1.5rem; border-radius: var(--border-radius); color: white; z-index: 1001; opacity: 0; transform: translateY(-20px); transition: opacity var(--transition-speed) ease, transform var(--transition-speed) ease; box-shadow: 0 8px 32px 0 rgba(0,0,0,0.2); }
      .toast.show { opacity: 1; transform: translateY(0); }
      .toast.success { background: var(--green); }
      .toast.error { background: var(--red); }
      
      table { width: 100%; border-collapse: collapse; margin-top: 2rem; }
      th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid var(--border-color); }
      th { color: var(--heading-color); font-weight: 600; }
      tbody tr:last-child td { border-bottom: none; }

      @media (max-width: 768px) {
        body::before, body::after { filter: blur(60px); }
        .flex { grid-template-columns: 1fr; }
        header { flex-direction: column; gap: 1rem; align-items: flex-start; }
      }
    </style>
</head>
<body>
    <main class="container">
      <header>
        <hgroup>
            <h1>🐳 Docker Manager</h1>
            <h2>A simple dashboard for your GHCR images</h2>
        </hgroup>
        <nav>
          <button class="secondary" id="nginx-modal-btn">⚡ Nginx</button>
          <a href="#" role="button" class="secondary" onclick="location.reload()">🔄 Refresh</a>
          <details role="list">
            <summary aria-haspopup="listbox">Theme</summary>
            <ul role="listbox">
              <li><a href="#" data-theme-switcher="auto">Auto</a></li>
              <li><a href="#" data-theme-switcher="light">Light</a></li>
              <li><a href="#" data-theme-switcher="dark">Dark</a></li>
            </ul>
          </details>
        </nav>
      </header>
        
      <div class="image-grid" id="image-grid">
        {{IMAGES_HTML}}
      </div>
      
      <div class="card" style="margin-top: 2rem;">
        <h3>Nginx Mappings</h3>
        <table id="nginx-mappings-table">
            <thead><tr><th>Domain</th><th>Proxy Port</th><th>Max Body Size</th></tr></thead>
            <tbody>{{NGINX_MAPPINGS_HTML}}</tbody>
        </table>
      </div>
    </main>

    <div id="modal" class="modal-overlay" style="display:none;">
      <div class="modal-content">
        <header>
          <h2 id="modal-title"></h2>
          <a href="#close" aria-label="Close" class="close" id="modal-close" data-target="modal"></a>
        </header>
        <div class="modal-body"><pre id="modal-output"></pre></div>
        <footer>
          <button id="modal-refresh" style="display:none;">Close & Refresh</button>
        </footer>
      </div>
    </div>
    
    <div id="nginx-modal" class="modal-overlay" style="display:none;">
      <div class="modal-content">
          <header>
              <h2>Nginx Control Panel</h2>
              <a href="#close" class="close" id="nginx-modal-close"></a>
          </header>
          <div class="modal-body">
              <textarea id="nginx-config-editor" spellcheck="false">Loading Nginx config...</textarea>
          </div>
          <footer>
              <button id="nginx-save-btn">💾 Save, Test & Reload</button>
          </footer>
      </div>
    </div>
    
    <div id="toast" class="toast"></div>

    <script>
      // PicoJS v2 Theme switcher logic
      const themeSwitcher={_scheme:"auto",menuTarget:"details[role='list']",buttonsTarget:"a[data-theme-switcher]",buttonAttribute:"data-theme-switcher",rootAttribute:"data-theme",localStorageKey:"picoPreferedColorScheme",init(){this.scheme=this.schemeFromLocalStorage,this.initSwitchers()},get schemeFromLocalStorage(){return window.localStorage?.getItem(this.localStorageKey)??this._scheme},get preferredColorScheme(){return window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"},initSwitchers(){const e=document.querySelectorAll(this.buttonsTarget);e.forEach(e=>{e.addEventListener("click",t=>{t.preventDefault(),this.scheme=e.getAttribute(this.buttonAttribute),document.querySelector(this.menuTarget)?.removeAttribute("open")},!1)})},set scheme(e){"auto"==e?this._scheme=this.preferredColorScheme:"dark"!=e&&"light"!=e||(this._scheme=e),this.applyScheme(),this.schemeToLocalStorage()},get scheme(){return this._scheme},applyScheme(){document.querySelector("html")?.setAttribute(this.rootAttribute,this.scheme)},schemeToLocalStorage(){window.localStorage?.setItem(this.localStorageKey,this.scheme)}};
      themeSwitcher.init();

      // Application script
      const modal = document.getElementById('modal');
      const modalTitle = document.getElementById('modal-title');
      const modalOutput = document.getElementById('modal-output');
      const modalClose = document.getElementById('modal-close');
      const modalRefresh = document.getElementById('modal-refresh');
      
      const nginxModal = document.getElementById('nginx-modal');
      const nginxConfigEditor = document.getElementById('nginx-config-editor');
      const nginxModalBtn = document.getElementById('nginx-modal-btn');
      const nginxModalClose = document.getElementById('nginx-modal-close');
      const nginxSaveBtn = document.getElementById('nginx-save-btn');

      function showToast(message, type = 'success') {
          const toast = document.getElementById('toast');
          toast.textContent = message;
          toast.className = 'toast show ' + type;
          setTimeout(() => { toast.className = 'toast'; }, 3000);
      }

      async function streamAction(url, title, options = {}) {
          modalTitle.textContent = title;
          modalOutput.textContent = 'Connecting to stream...';
          modalRefresh.style.display = 'none';
          modal.style.display = 'flex';

          try {
              const response = await fetch(url, options);
              if (!response.ok) throw new Error(\`Server error: \${response.status}\`);
              
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              modalOutput.textContent = '';

              while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  const chunk = decoder.decode(value, { stream: true });
                  modalOutput.textContent += chunk;
                  modalOutput.parentElement.scrollTop = modalOutput.parentElement.scrollHeight;
              }
              if (!modalOutput.textContent.includes('ERROR')) {
                 modalOutput.textContent += "\\n\\n✅ Stream finished successfully.";
              }
          } catch (error) {
              modalOutput.textContent += \`\\n\\n❌ Error: \${error.message}\`;
          } finally {
              modalOutput.parentElement.scrollTop = modalOutput.parentElement.scrollHeight;
              modalRefresh.style.display = 'inline-block';
          }
      }

      async function postAction(url, body, button) {
          button.setAttribute('aria-busy', 'true');
          button.disabled = true;
          try {
              const response = await fetch(url, { method: 'POST', body });
              const result = await response.json();
              if (!response.ok) throw new Error(result.error || 'Unknown error');
              showToast(result.message || 'Action successful!', 'success');
              if (result.promptReload) {
                  showToast('Nginx config updated. Please test & reload.', 'success');
              } else {
                  setTimeout(() => location.reload(), 1500);
              }
          } catch (error) {
              showToast(\`Error: \${error.message}\`, 'error');
          } finally {
               button.setAttribute('aria-busy', 'false');
               button.disabled = false;
          }
      }

      document.getElementById('image-grid').addEventListener('click', e => {
          if (e.target.matches('.action-btn')) handleActionButton(e.target);
          else if (e.target.matches('.save-env-btn')) saveEnvironmentVariables(e.target);
      });
      
      document.getElementById('image-grid').addEventListener('input', e => {
          if (e.target.matches('.config-input')) saveConfigurationForService(e.target);
      });

      function handleActionButton(btn) {
          const { action, image, containerId, containerName, service } = btn.dataset;
          switch(action) {
              case 'update':
                  streamAction(\`/pull-stream?image=\${encodeURIComponent(image)}\`, \`Updating: \${image}\`);
                  break;
              case 'logs':
                  streamAction(\`/logs-stream?container=\${containerId}\`, \`Logs for: \${containerName}\`);
                  break;
              case 'start-compose':
                  startOrRecreateCompose(btn, service, image, false);
                  break;
              case 'recreate-compose':
                  if (!confirm(\`This will STOP, REMOVE, and RECREATE the container for '\${service}' with the current settings. Are you sure?\`)) return;
                  startOrRecreateCompose(btn, service, image, true);
                  break;
              case 'stop':
              case 'restart':
              case 'remove':
                  if (action === 'remove' && !confirm(\`Are you sure you want to remove container \${containerName}?\`)) return;
                  const formData = new FormData();
                  formData.append('container', containerId);
                  postAction(\`/\${action}\`, formData, btn);
                  break;
          }
      }
      
      function startOrRecreateCompose(btn, serviceName, imageName, isRecreate) {
          const configInputs = document.querySelectorAll(\`.config-input[data-service="\${serviceName}"]\`);
          const config = {};
          configInputs.forEach(input => {
              const key = input.dataset.config;
              const value = input.value.trim();
              if (value || key === 'domain') config[key] = value; // also send empty domain to remove it
          });
          
          const composeData = new FormData();
          composeData.append('service', serviceName);
          composeData.append('image', imageName);
          composeData.append('config', JSON.stringify(config));
          if (isRecreate) {
            composeData.append('recreate', 'true');
          }
          
          postAction('/start-compose', composeData, btn);
      }

      function saveEnvironmentVariables(btn) {
          const serviceName = btn.dataset.service;
          const textarea = document.querySelector(\`.env-vars[data-service="\${serviceName}"]\`);
          const envContent = textarea.value.trim();
          
          const envVars = {};
          if (envContent) {
              envContent.split('\\n').forEach(line => {
                  const trimmed = line.trim();
                  if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                      const [key, ...valueParts] = trimmed.split('=');
                      if (key.trim()) envVars[key.trim()] = valueParts.join('=').trim();
                  }
              });
          }
          
          btn.disabled = true;
          btn.setAttribute('aria-busy', 'true');
          
          fetch('/save-env', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ service: serviceName, envVars })
          }).then(response => {
              if (response.ok) {
                  showToast('Environment variables saved!', 'success');
                  btn.textContent = '✅ Saved';
                  setTimeout(() => {
                      btn.textContent = '💾 Save Env';
                      btn.disabled = false;
                      btn.setAttribute('aria-busy', 'false');
                  }, 2000);
              } else { throw new Error('Failed to save'); }
          }).catch(error => {
              showToast(\`Error: \${error.message}\`, 'error');
              btn.textContent = '💾 Save Env';
              btn.disabled = false;
              btn.setAttribute('aria-busy', 'false');
          });
      }

      function saveConfigurationForService(input) {
          const serviceName = input.dataset.service;
          const configInputs = document.querySelectorAll(\`.config-input[data-service="\${serviceName}"]\`);
          const config = {};
          configInputs.forEach(configInput => {
              const key = configInput.dataset.config;
              const value = configInput.value.trim();
              if (value) config[key] = value;
          });
          
          fetch('/save-config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ service: serviceName, config })
          });
          showToast(\`Config for \${serviceName} autosaved. Recreate to apply.\`, 'success');
      }
      
      // Nginx Modal Logic
      nginxModalBtn.addEventListener('click', async () => {
          nginxConfigEditor.value = 'Loading Nginx config...';
          nginxModal.style.display = 'flex';
          try {
              const response = await fetch('/nginx/config');
              const text = await response.text();
              nginxConfigEditor.value = text;
          } catch (e) {
              nginxConfigEditor.value = 'Error loading config: ' + e.message;
          }
      });
      nginxSaveBtn.addEventListener('click', () => {
          const newConfig = nginxConfigEditor.value;
          const options = {
            method: 'POST',
            headers: {'Content-Type': 'text/plain'},
            body: newConfig
          };
          nginxModal.style.display = 'none';
          streamAction('/nginx/update-config-stream', 'Updating Nginx Configuration', options);
      });

      nginxModalClose.addEventListener('click', () => nginxModal.style.display = 'none');

      modalClose.addEventListener('click', (e) => { e.preventDefault(); modal.style.display = 'none'});
      modalRefresh.addEventListener('click', () => location.reload());
    </script>
</body>
</html>
`;

app.get('/', async (c) => {
  try {
    const { images, nginxConfig } = await getImageInfo();

    const imagesHtml = images.map(img => {
      const envVarsString = Object.entries(img.envVars).map(([k, v]) => `${k}=${v}`).join('\n');
      return `
      <article>
        <header>
          <hgroup>
            <h3>${img.name}</h3>
            <h5><span class="status ${img.status}">${img.status.replace(/_/g, ' ')}</span></h5>
          </hgroup>
        </header>
        
        <div class="flex">
          <div class="details">
            <p><span>Local Tag</span> <code>${img.localTag || 'N/A'}</code></p>
            <p><span>Remote Tag</span> <code>${img.remoteTag}</code></p>
            <p><span>Container</span> <code>${img.containerName || 'N/A'}</code></p>
            <p><span>Size</span> <code>${img.size || 'N/A'}</code></p>
            <p><span>Ports (H:C)</span> <code>${img.config.hostPort || 'N/A'}:${img.config.containerPort || 'N/A'}</code></p>
            <p><span>Domain</span> <code>${img.config.domain ? `${img.config.domain}.${BASE_DOMAIN}` : 'N/A'}</code></p>
          </div>
          
          <div class="actions">
            <button class="action-btn" data-action="update" data-image="ghcr.io/web-iiitkota/${img.name}:${img.remoteTag}">🔄 Update/Pull</button>
            
            ${img.containerId ? `
              <div class="grid">
                <button class="action-btn secondary" data-action="restart" data-container-id="${img.containerId}" data-container-name="${img.name}">🔄 Restart</button>
                <button class="action-btn contrast" data-action="stop" data-container-id="${img.containerId}" data-container-name="${img.name}">⏹️ Stop</button>
              </div>
              <div class="grid">
                <button class="action-btn contrast outline" data-action="remove" data-container-id="${img.containerId}" data-container-name="${img.name}">🗑️ Remove</button>
                <button class="action-btn outline" data-action="logs" data-container-id="${img.containerId}" data-container-name="${img.name}">📄 Logs</button>
              </div>
            ` : `
              <button class="action-btn" data-action="start-compose" data-service="${img.name}" data-image="ghcr.io/web-iiitkota/${img.name}:${img.localTag || img.remoteTag}" ${!img.localTag ? 'disabled' : ''}>🚀 Start</button>
            `}
          </div>
        </div>
        
        <details style="margin-top: 1rem;">
            <summary>Environment & Configuration</summary>
            <div style="margin-top: 1rem;">
              <label for="env-${img.name}">Environment Variables</label>
              <textarea id="env-${img.name}" class="env-vars" data-service="${img.name}" placeholder="KEY1=value1&#10;KEY2=value2" style="height: 80px; font-size: 0.8em;">${envVarsString}</textarea>
              <button class="save-env-btn secondary" data-service="${img.name}" style="width: 100%; margin-top: 0.5rem; font-size: 0.8rem; padding: 0.5rem;">💾 Save Env</button>
            </div>
            <div class="grid" style="margin-top: 1rem;">
                <div>
                    <label>Host Port</label>
                    <input type="text" class="config-input" data-config="hostPort" data-service="${img.name}" value="${img.config.hostPort || ''}" placeholder="e.g. 8081">
                </div>
                <div>
                    <label>Container Port</label>
                    <input type="text" class="config-input" data-config="containerPort" data-service="${img.name}" value="${img.config.containerPort || ''}" placeholder="e.g. 3000">
                </div>
                <div>
                    <label>CPU Limit</label>
                    <input type="text" class="config-input" data-config="cpuLimit" data-service="${img.name}" value="${img.config.cpuLimit || ''}" placeholder="e.g. 0.5">
                </div>
                <div>
                    <label>Memory Limit</label>
                    <input type="text" class="config-input" data-config="memoryLimit" data-service="${img.name}" value="${img.config.memoryLimit || ''}" placeholder="e.g. 512M">
                </div>
            </div>
              <label for="domain-${img.name}" style="margin-top: 1rem;">Domain</label>
              <div class="input-group">
                  <input type="text" id="domain-${img.name}" class="config-input" data-config="domain" data-service="${img.name}" value="${img.config.domain || ''}" placeholder="subdomain">
                  <span>.${BASE_DOMAIN}</span>
              </div>
              <div class="grid" style="margin-top: 1rem;">
                <div>
                    <label>Client Max Body Size</label>
                    <input type="text" class="config-input" data-config="clientMaxBodySize" data-service="${img.name}" value="${img.config.clientMaxBodySize || '10M'}" placeholder="e.g. 10M">
                </div>
                  <div>
                    <label>Restart Policy</label>
                    <select class="config-input" data-config="restartPolicy" data-service="${img.name}">
                      <option value="unless-stopped" ${img.config.restartPolicy === 'unless-stopped' ? 'selected' : ''}>unless-stopped</option>
                      <option value="always" ${img.config.restartPolicy === 'always' ? 'selected' : ''}>always</option>
                      <option value="on-failure" ${img.config.restartPolicy === 'on-failure' ? 'selected' : ''}>on-failure</option>
                      <option value="no" ${img.config.restartPolicy === 'no' ? 'selected' : ''}>no</option>
                    </select>
                </div>
            </div>
            ${img.containerId ? `
              <div style="margin-top: 1.5rem; border-top: 1px solid var(--border-color); padding-top: 1.5rem; text-align: center;">
                <button class="action-btn" data-action="recreate-compose" data-service="${img.name}" data-image="ghcr.io/web-iiitkota/${img.name}:${img.localTag || img.remoteTag}">💾 Save & Recreate Container</button>
                <p style="font-size: 0.8em; opacity: 0.7; margin-top: 0.5rem;">Recreates the container with the new configuration above.</p>
              </div>
            ` : ''}
        </details>
        <footer><small>Image ID: <code>${img.localImageId || 'N/A'}</code></small></footer>
      </article>
      `
    }).join('');

    const nginxMappingsHtml = nginxConfig.map(m => `
      <tr>
        <td><code>${m.server_name}</code></td>
        <td><code>${m.proxy_pass_port}</code></td>
        <td><code>${m.client_max_body_size}</code></td>
      </tr>
    `).join('') || '<tr><td colspan="3" style="text-align: center;">No Nginx mappings found.</td></tr>';

    const finalHtml = htmlTemplate
      .replace('{{IMAGES_HTML}}', imagesHtml || '<article><p>No images found.</p></article>')
      .replace('{{NGINX_MAPPINGS_HTML}}', nginxMappingsHtml);

    return c.html(finalHtml);

  } catch (error) {
    console.error('Error:', error);
    const errorHtml = `<article style="background-color: var(--contrast); color: white; grid-column: 1 / -1;"><h4>An error occurred</h4><p>${error.message}</p></article>`;
    return c.html(htmlTemplate.replace('{{IMAGES_HTML}}', errorHtml).replace('{{NGINX_MAPPINGS_HTML}}', ''), 500);
  }
});


// --- Streaming API Routes ---
app.get('/pull-stream', async (c) => {
  const imageName = c.req.query('image')
  if (!imageName) return c.text('Image name is required', 400)
  return stream(c, async (stream) => {
    try {
      await stream.write(new TextEncoder().encode(`PULLING IMAGE: ${imageName}\n\n`))
      const dockerStream = await docker.pull(imageName, { authconfig: dockerAuthConfig })
      await new Promise((resolve, reject) => {
          docker.modem.followProgress(dockerStream, (err, res) => err ? reject(err) : resolve(res), (event) => {
            stream.write(new TextEncoder().encode(JSON.stringify(event) + '\n'))
          });
      });
      await stream.write(new TextEncoder().encode(`\nSUCCESS: Image pull complete for ${imageName}\n`))
    } catch (error) {
      console.error(`Pull stream error for ${imageName}:`, error)
      await stream.write(new TextEncoder().encode(`\nERROR: ${error}\n`))
    }
  })
})

app.get('/logs-stream', async (c) => {
    const containerId = c.req.query('container');
    if (!containerId) return c.text('Container ID is required', 400);
    try {
        const container = docker.getContainer(containerId);
        const logStream = await container.logs({ stdout: true, stderr: true, follow: false, timestamps: true, tail: 100 }) as any;
        let logText = '';
        if (Buffer.isBuffer(logStream)) {
            logText = logStream.toString('utf8');
            const lines = logText.split('\n');
            logText = lines
                .map(line => line.trim() ? (line.length > 8 && line.charCodeAt(0) <= 3 ? line.slice(8) : line) : '')
                .filter(Boolean)
                .join('\n');
        }
        logText += '\n--- End of logs ---\n';
        return c.text(logText);
    } catch (error) {
        console.error(`Log stream error for ${containerId}:`, error);
        return c.text(`ERROR: ${error}`, 500);
    }
});

// --- POST/GET API Routes ---
app.get('/nginx/config', async (c) => {
    try {
        if (existsSync(NGINX_CONFIG_PATH)) {
            const content = readFileSync(NGINX_CONFIG_PATH, 'utf-8');
            return c.text(content);
        }
        return c.text(`# Nginx config file not found at: ${NGINX_CONFIG_PATH}`, 404);
    } catch (error) {
        return c.text(`Error reading Nginx config: ${error.message}`, 500);
    }
});


app.post('/save-config', async (c) => {
  const body = await c.req.json()
  const { service, config } = body
  if (!service || typeof config !== 'object') {
    return c.json({ error: 'Service name and config object required' }, 400)
  }
  try {
    const configPath = join(ensureEnvDir(service), 'config.json')
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    return c.json({ message: 'Configuration saved successfully!' })
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to save configuration' }, 500)
  }
})

app.post('/save-env', async (c) => {
  const body = await c.req.json()
  const { service, envVars } = body
  if (!service || typeof envVars !== 'object') {
    return c.json({ error: 'Service name and envVars object required' }, 400)
  }
  try {
    writeEnvFile(service, envVars)
    return c.json({ message: 'Environment variables saved successfully!' })
  } catch (error: any) {
    return c.json({ error: error.message || 'Failed to save environment variables' }, 500)
  }
})

app.post('/start-compose', async (c) => {
  const body = await c.req.formData()
  const serviceName = body.get('service') as string
  const imageName = body.get('image') as string
  const configData = body.get('config') as string
  const isRecreating = body.get('recreate') === 'true';

  if (!serviceName || !imageName) return c.json({ error: 'Service and image name required' }, 400);

  try {
    const composeDir = ensureEnvDir(serviceName);
    
    // Get old config to find the previous Nginx block
    const configPath = join(composeDir, 'config.json')
    let oldConfig: Partial<ResourceLimits> = {};
      if (existsSync(configPath)) {
          try {
              oldConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
          } catch { /* ignore parse error */ }
      }

    if (isRecreating) {
        const downProc = Bun.spawn(['docker', 'compose', 'down'], { cwd: composeDir, stderr: 'pipe' });
        await downProc.exited;
    } else {
      try {
        const existingContainer = docker.getContainer(serviceName);
        await existingContainer.inspect();
        return c.json({ error: `Container '${serviceName}' already exists. Remove it first.` }, 409);
      } catch (error) {
        if (error.statusCode !== 404) throw error;
      }
    }

    let userConfig: any = configData ? JSON.parse(configData) : {};
    const finalConfig: ResourceLimits = {
      ...getDefaultConfig(serviceName),
      ...userConfig
    };

    const tag = imageName.split(':').pop() || 'latest';
    const composeContent = createDockerComposeContent(serviceName, tag, finalConfig);
    const composePath = join(composeDir, 'docker-compose.yml');
    writeFileSync(composePath, composeContent, 'utf-8');

    const result = Bun.spawn(['docker', 'compose', 'up', '-d'], { cwd: composeDir });
    const exitCode = await result.exited;

    if (exitCode !== 0) throw new Error(`Docker-compose failed with exit code ${exitCode}`);

    // --- Smart Nginx Update Logic ---
    let promptNginxReload = false;
    // Only touch Nginx if domain or host port is part of the config
    if (userConfig.hasOwnProperty('domain') || userConfig.hasOwnProperty('hostPort')) {
      let nginxContent = '';
      if (existsSync(NGINX_CONFIG_PATH)) {
        nginxContent = readFileSync(NGINX_CONFIG_PATH, 'utf-8');
      }

      // Find the old block using the old host port, which is a reliable identifier
      let blockToReplace: NginxServerConfig | undefined;
      if (oldConfig.hostPort) {
        const parsedServers = parseNginxConfig(nginxContent);
        blockToReplace = parsedServers.find(s => s.proxy_pass_port === oldConfig.hostPort);
      }
      
      let newNginxContent = nginxContent;
      // Case 1: A new domain is being set/updated
      if (userConfig.domain && finalConfig.hostPort) {
        promptNginxReload = true;
        const clientMaxSize = userConfig.clientMaxBodySize || '10M';
        const newBlock = createNginxServerBlock(userConfig.domain, finalConfig.hostPort, clientMaxSize);

        if (blockToReplace) { // Update existing block
            newNginxContent = nginxContent.replace(blockToReplace.raw_block, newBlock);
        } else { // Add new block
            newNginxContent = (nginxContent.trim() + '\n\n' + newBlock).trim();
        }
      } 
      // Case 2: The domain is being removed
      else if (blockToReplace) {
        promptNginxReload = true;
        newNginxContent = nginxContent.replace(blockToReplace.raw_block, '').replace(/^\s*[\r\n]/gm, ''); // Remove block and extra newlines
      }

      if (promptNginxReload) {
        writeFileSync(NGINX_CONFIG_PATH, newNginxContent, 'utf-8');
      }
    }
    
    const message = `Container ${serviceName} ${isRecreating ? 'recreated' : 'started'}!`;
    return c.json({ message, promptReload: promptNginxReload });

  } catch (error: any) {
    console.error('Compose start/recreate error:', error);
    return c.json({ error: error.message || 'Failed to start with compose' }, 500);
  }
});

app.post('/nginx/update-config-stream', (c) => {
    return stream(c, async (stream) => {
        try {
            const newConfigContent = await c.req.text();
            if (!existsSync(NGINX_CONFIG_PATH)) {
                await stream.write(new TextEncoder().encode(`ERROR: Nginx config path not found: ${NGINX_CONFIG_PATH}\n`));
                return;
            }

            // 1. Backup
            const backupPath = join(BACKUP_DIR, `iiit-apis-backup-${Date.now()}.conf`);
            await stream.write(new TextEncoder().encode(`[1/4] Creating backup at ${backupPath}...\n`));
            copyFileSync(NGINX_CONFIG_PATH, backupPath);
            await stream.write(new TextEncoder().encode(`✅ Backup created.\n\n`));

            // 2. Write new config
            await stream.write(new TextEncoder().encode(`[2/4] Writing new configuration...\n`));
            writeFileSync(NGINX_CONFIG_PATH, newConfigContent, 'utf-8');
            await stream.write(new TextEncoder().encode(`✅ New configuration written.\n\n`));
            
            // 3. Test config
            await stream.write(new TextEncoder().encode(`[3/4] Testing Nginx configuration (sudo nginx -t)...\n`));
            const testProc = Bun.spawn(['sudo', 'nginx', '-t'], { stderr: 'pipe', stdout: 'pipe' });
            const testExitCode = await testProc.exited;
            const testStderr = await new Response(testProc.stderr).text();
            const testStdout = await new Response(testProc.stdout).text();

            // 4. Handle result
            if (testExitCode !== 0) {
                await stream.write(new TextEncoder().encode(`\n❌ Nginx test FAILED!\n\n`));
                await stream.write(new TextEncoder().encode(`--- ERROR OUTPUT ---\n${testStderr || testStdout}\n--------------------\n\n`));
                await stream.write(new TextEncoder().encode(`Restoring configuration from backup...\n`));
                copyFileSync(backupPath, NGINX_CONFIG_PATH);
                await stream.write(new TextEncoder().encode(`✅ Backup restored. Your original configuration is safe.\n`));
            } else {
                await stream.write(new TextEncoder().encode(`✅ Nginx test successful.\n\n`));
                await stream.write(new TextEncoder().encode(`[4/4] Reloading Nginx service (sudo systemctl reload nginx)...\n`));
                const reloadProc = Bun.spawn(['sudo', 'systemctl', 'reload', 'nginx'], { stderr: 'pipe' });
                const reloadExitCode = await reloadProc.exited;
                const reloadStderr = await new Response(reloadProc.stderr).text();
                if (reloadExitCode !== 0) {
                    await stream.write(new TextEncoder().encode(`\n❌ Nginx reload FAILED!\n\n--- ERROR OUTPUT ---\n${reloadStderr}\n--------------------\n\n`));
                    await stream.write(new TextEncoder().encode(`The configuration is valid, but the service failed to reload. Please check server logs.\n`));
                } else {
                    await stream.write(new TextEncoder().encode(`✅ Nginx service reloaded successfully.\n`));
                }
            }
        } catch (error) {
            await stream.write(new TextEncoder().encode(`\n\nFATAL SCRIPT ERROR: ${error.message}\n`));
        }
    });
});


const handleContainerAction = (action: (container: Docker.Container) => Promise<any>) => async (c: any) => {
  const body = await c.req.formData()
  const containerId = body.get('container') as string
  if (!containerId) return c.json({ error: 'Container ID required' }, 400)
  try {
    const container = docker.getContainer(containerId)
    await action(container)
    const actionName = action.toString().includes('stop') ? 'stopped' : action.toString().includes('restart') ? 'restarted' : 'removed'
    return c.json({ message: `Container ${containerId.slice(0,12)} ${actionName} successfully!` })
  } catch (error: any) {
    return c.json({ error: error.message || 'Action failed' }, 500)
  }
}

app.post('/stop', handleContainerAction(container => container.stop()))
app.post('/restart', handleContainerAction(container => container.restart()))
app.post('/remove', handleContainerAction(container => container.remove({ force: true })))

console.log(`🐳 Docker Manager starting on port ${PORT}`)
console.log(`🔗 Access at: http://localhost:${PORT}`)
console.log(`🔐 Credentials: ${AUTH_USERNAME} / ${AUTH_PASSWORD}`)

export default {
  port: parseInt(PORT),
  fetch: app.fetch,
  idleTimeout: 30,
}