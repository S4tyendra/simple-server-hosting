# Only for ubuntu

import os
import subprocess
import random
import secrets
import asyncio
from fastapi import FastAPI, HTTPException, Depends, Request, Form, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from starlette.status import HTTP_401_UNAUTHORIZED
import git
import uvicorn
import json
import dns.resolver
import socket
import requests

def is_domain_pointing(domain, target_ip):
    try:
        answers = dns.resolver.resolve(domain, 'A')
        for rdata in answers:
            if rdata.address == target_ip:
                return True
        return False
    except dns.resolver.NXDOMAIN:
        return False

def get_server_ip():
    return requests.get('https://api.ipify.org').text

app = FastAPI()
security = HTTPBasic()

USERNAME = "yourusername"
PASSWORD = "yourpassword"

USER  = os.getlogin() # ubuntu username

APPS_DIR = f"/home/{USER}/server/apps"
NGINX_CONF_DIR = "/etc/nginx/sites-available"

UV = f"/home/{USER}/.local/bin/uv"

# Un comment below line if uv is not installed 
# os.system("curl -LsSf https://astral.sh/uv/install.sh | sh")

os.makedirs(APPS_DIR, exist_ok=True)

with open("head.html", "r") as f:
    HEAD = f.read()

def get_current_username(credentials: HTTPBasicCredentials = Depends(security)):
    correct_username = secrets.compare_digest(credentials.username, USERNAME)
    correct_password = secrets.compare_digest(credentials.password, PASSWORD)
    if not (correct_username and correct_password):
        raise HTTPException(
            status_code=HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Basic"},
        )
    return credentials.username

@app.get("/", response_class=HTMLResponse)
async def home(username: str = Depends(get_current_username)):
    apps = os.listdir(APPS_DIR)
    app_list = "".join([f"<li><a href='/app/{app}'>{app}</a></li>" for app in apps])
    return f"""
    <html>
        <head>{HEAD}</head>
        <body>
            <h1>Running Apps</h1>
            <ul>{app_list}</ul>
            <a href="/new_app">Create New App</a>
        </body>
    </html>
    """

@app.get("/new_app", response_class=HTMLResponse)
async def new_app_form(username: str = Depends(get_current_username)):
    return f"""
    <html>
        <head>{HEAD}</head>
        <body>
            <h1>Create New App</h1>
            <form id="newAppForm">
                <label>Repo URL: <input type="text" name="repo_url" required></label><br>
                <label>Domain: <input type="text" name="domain" required></label><br>
                <label>Install Command: <input type="text" name="install_cmd" value="{UV} pip install -r requirements.txt"></label><br>
                <label>Start Command: <input type="text" name="start_cmd" value="hypercorn main:app -b 127.0.0.1:$PORT"></label><br>
                <input type="submit" value="Create App">
            </form>
            <div id="output"></div>
            <script>
                const output = document.getElementById('output');
                const form = document.getElementById('newAppForm');
                
                form.addEventListener('submit', function(e) {{
                    e.preventDefault();
                    const formData = new FormData(form);
                    const repoUrl = formData.get('repo_url');
                    const domain = formData.get('domain');
                    const installCmd = formData.get('install_cmd');
                    const startCmd = formData.get('start_cmd');
                    
                    const ws = new WebSocket(`wss://${{window.location.host}}/ws/new_app?repo_url=${{repoUrl}}&domain=${{domain}}&install_cmd=${{encodeURIComponent(installCmd)}}&start_cmd=${{encodeURIComponent(startCmd)}}`);
                    
                    ws.onmessage = function(event) {{
                        output.innerHTML += event.data + '<br>';
                        output.scrollTop = output.scrollHeight;
                    }};
                    
                    ws.onclose = function(event) {{
                        if (event.code === 1000) {{
                            output.innerHTML += 'App creation completed successfully.<br>';
                            window.location.href = '/app/' + repoUrl.split('/').pop().replace('.git', '');
                        }} else {{
                            output.innerHTML += 'App creation failed or was interrupted.<br>';
                        }}
                    }};
                }});
            </script>
        </body>
    </html>
    """

async def run_command(command, websocket):
    process = await asyncio.create_subprocess_exec(
        '/bin/bash', '-c', command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )

    async def read_stream(stream):
        while True:
            line = await stream.readline()
            if line:
                await websocket.send_text(line.decode().strip())
            else:
                break

    await asyncio.gather(
        read_stream(process.stdout),
        read_stream(process.stderr)
    )

    return await process.wait()

@app.websocket("/ws/new_app")
async def websocket_new_app(websocket: WebSocket, repo_url: str, domain: str, install_cmd: str, start_cmd: str):
    await websocket.accept()
    
    repo_name = repo_url.split("/")[-1].replace(".git", "")
    app_dir = os.path.join(APPS_DIR, repo_name)
    
    try:
        await websocket.send_text(f"Cloning repository {repo_url}...")
        await run_command(f"rm -rf {app_dir}", websocket)
        clone_result = await run_command(f"git clone {repo_url} {app_dir}", websocket)
        if clone_result != 0:
            raise Exception("Failed to clone repository")

        await websocket.send_text("Creating virtual environment...")
        venv_result = await run_command(f"{UV} venv {app_dir}/venv", websocket)
        if venv_result != 0:
            raise Exception("Failed to create virtual environment")

        await websocket.send_text("Installing requirements...")
        venv_activate = os.path.join(f"{app_dir}/venv", "bin", "activate")
        full_cmd = f"source {venv_activate} && cd {app_dir} && {install_cmd}"
        install_result = await run_command(full_cmd, websocket)
        if install_result != 0:
            raise Exception("Failed to install requirements")

        port = random.randint(8000, 9000)
        tmux_session_name = repo_name

        await websocket.send_text(f"Starting app {repo_name} on port {port}...")
        start_cmd_with_port = start_cmd.replace("$PORT", str(port))
        command = f"tmux new-session -d -s {tmux_session_name} 'source {app_dir}/venv/bin/activate && cd {app_dir} && {start_cmd_with_port}'"
        start_result = await run_command(command, websocket)
        if start_result != 0:
            raise Exception("Failed to start the application")

        await websocket.send_text("Configuring Nginx...")
        nginx_conf = f"""
        server {{
            listen 80;
            server_name {domain};
            location / {{
                proxy_pass http://127.0.0.1:{port};
                proxy_set_header Host $host;
                proxy_set_header X-Real-IP $remote_addr;
            }}
        }}
        """
        with open(f"{NGINX_CONF_DIR}/{domain}", "w") as f:
            f.write(nginx_conf)

        await websocket.send_text("Reloading Nginx...")
        nginx_result = await run_command("nginx -s reload", websocket)
        if nginx_result != 0:
            raise Exception("Failed to reload Nginx")

        # Save app configuration
        config = {
            "repo_url": repo_url,
            "domain": domain,
            "install_cmd": install_cmd,
            "start_cmd": start_cmd,
            "port": port
        }
        with open(os.path.join(app_dir, "app_config.json"), "w") as f:
            json.dump(config, f)

        await websocket.send_text(f"App {repo_name} setup complete!")
    except Exception as e:
        await websocket.send_text(f"Error: {str(e)}")
        await run_command(f"rm -rf {app_dir}", websocket)
        await run_command(f"rm -f {NGINX_CONF_DIR}/{domain}", websocket)
        await run_command("nginx -s reload", websocket)
    finally:
        await websocket.close()

@app.get("/app/{app_name}", response_class=HTMLResponse)
async def app_details(app_name: str, username: str = Depends(get_current_username)):
    app_dir = os.path.join(APPS_DIR, app_name)
    
    try:
        with open(os.path.join(app_dir, "app_config.json"), "r") as f:
            config = json.load(f)
    except FileNotFoundError:
        config = {"domain": "Unknown", "port": "Unknown"}

    logs = subprocess.check_output(["tmux", "capture-pane", "-p", "-t", app_name]).decode()
    
    server_ip = get_server_ip()
    domain_pointing = is_domain_pointing(config['domain'], server_ip)
    
    return f"""
    <html>
        <head>{HEAD}</head>
        <body>
            <h1>{app_name}</h1>
            <p>Domain: {config['domain']}</p>
            <p>Port: {config['port']}</p>
            <p>Server IP: {server_ip}</p>
            <p>Domain Status: {'Pointing to this server' if domain_pointing else 'Not pointing to this server'}</p>
            <h2>DNS Management</h2>
            <p>To point your domain to this server, add an A record with the following details:</p>
            <ul>
                <li>Host: {config['domain']} </li>
                <li>Value: {server_ip}</li>
                <li>TTL: 3600 (or as desired)</li>
            </ul>
            <button onclick="checkDomain()">Check Domain Status</button>
            <h2>Logs:</h2>
            <pre>{logs}</pre>
            <h2>Actions:</h2>
            <button onclick="performAction('pull_rerun')">Pull and Rerun</button>
            <button onclick="performAction('pull_install_rerun')">Pull, Install, and Rerun</button>
            <button onclick="performAction('delete')">Delete App</button>
            <h2>Terminal Access:</h2>
            <a href="/app/{app_name}/terminal">Open Terminal</a>
            <div id="output"></div>
            <script>
                const output = document.getElementById('output');
                
                function performAction(action) {{
                    output.innerHTML = '';
                    const ws = new WebSocket(`wss://${{window.location.host}}/ws/app/{app_name}/${{action}}`);
                    
                    ws.onmessage = function(event) {{
                        output.innerHTML += event.data + '<br>';
                        output.scrollTop = output.scrollHeight;
                    }};
                    
                    ws.onclose = function(event) {{
                        if (event.code === 1000) {{
                            output.innerHTML += 'Action completed successfully.<br>';
                            if (action === 'delete') {{
                                window.location.href = '/';
                            }} else {{
                                location.reload();
                            }}
                        }} else {{
                            output.innerHTML += 'Action failed or was interrupted.<br>';
                        }}
                    }};
                }}
                
                function checkDomain() {{
                    fetch('/check_domain/{app_name}')
                        .then(response => response.json())
                        .then(data => {{
                            alert(data.message);
                            if (data.status) {{
                                location.reload();
                            }}
                        }});
                }}
            </script>
        </body>
    </html>
    """

@app.get("/check_domain/{app_name}")
async def check_domain(app_name: str, username: str = Depends(get_current_username)):
    app_dir = os.path.join(APPS_DIR, app_name)
    
    with open(os.path.join(app_dir, "app_config.json"), "r") as f:
        config = json.load(f)
    
    server_ip = get_server_ip()
    domain_pointing = is_domain_pointing(config['domain'], server_ip)
    
    if domain_pointing:
        message = f"The domain {config['domain']} is correctly pointing to this server ({server_ip})."
    else:
        message = f"The domain {config['domain']} is not pointing to this server ({server_ip}). Please update your DNS settings."
    
    return {"status": domain_pointing, "message": message}

@app.websocket("/ws/app/{app_name}/{action}")
async def websocket_app_action(websocket: WebSocket, app_name: str, action: str):
    await websocket.accept()
    
    app_dir = os.path.join(APPS_DIR, app_name)
    
    try:
        with open(os.path.join(app_dir, "app_config.json"), "r") as f:
            config = json.load(f)

        if action == "pull_rerun":
            await websocket.send_text(f"Pulling latest changes for {app_name}...")
            await run_command(f"cd {app_dir} && git pull", websocket)

            await websocket.send_text(f"Restarting {app_name}...")
            await run_command(f"tmux kill-session -t {app_name}", websocket)
            
            port = random.randint(8000, 9000)
            start_cmd_with_port = config['start_cmd'].replace("$PORT", str(port))
            command = f"tmux new-session -d -s {app_name} 'source {app_dir}/venv/bin/activate && cd {app_dir} && {start_cmd_with_port}'"
            await run_command(command, websocket)

            # Update Nginx configuration
            nginx_conf = f"""
            server {{
                listen 80;
                server_name {config['domain']};
                location / {{
                    proxy_pass http://127.0.0.1:{port};
                    proxy_set_header Host $host;
                    proxy_set_header X-Real-IP $remote_addr;
                }}
            }}
            """
            with open(f"{NGINX_CONF_DIR}/{config['domain']}", "w") as f:
                f.write(nginx_conf)

            await run_command("nginx -s reload", websocket)

            # Update app configuration
            config['port'] = port
            with open(os.path.join(app_dir, "app_config.json"), "w") as f:
                json.dump(config, f)

            await websocket.send_text(f"{app_name} restarted successfully!")
        
        elif action == "pull_install_rerun":
            await websocket.send_text(f"Pulling latest changes for {app_name}...")
            await run_command(f"cd {app_dir} && git pull", websocket)

            await websocket.send_text("Installing requirements...")
            venv_activate = os.path.join(f"{app_dir}/venv", "bin", "activate")
            full_cmd = f"source {venv_activate} && cd {app_dir} && {config['install_cmd']}"
            await run_command(full_cmd, websocket)

            await websocket.send_text(f"Restarting {app_name}...")
            await run_command(f"tmux kill-session -t {app_name}", websocket)
            
            port = random.randint(8000, 9000)
            start_cmd_with_port = config['start_cmd'].replace("$PORT", str(port))
            command = f"tmux new-session -d -s {app_name} 'source {app_dir}/venv/bin/activate && cd {app_dir} && {start_cmd_with_port}'"
            await run_command(command, websocket)

            # Update Nginx configuration
            nginx_conf = f"""
            server {{
                listen 80;
                server_name {config['domain']};
                location / {{
                    proxy_pass http://127.0.0.1:{port};
                    proxy_set_header Host $host;
                    proxy_set_header X-Real-IP $remote_addr;
                }}
            }}
            """
            with open(f"{NGINX_CONF_DIR}/{config['domain']}", "w") as f:
                f.write(nginx_conf)

            await run_command("nginx -s reload", websocket)

            # Update app configuration
            config['port'] = port
            with open(os.path.join(app_dir, "app_config.json"), "w") as f:
                json.dump(config, f)

            await websocket.send_text(f"{app_name} updated and restarted successfully!")
        
        elif action == "delete":
            await websocket.send_text(f"Deleting app {app_name}...")
            await run_command(f"tmux kill-session -t {app_name}", websocket)
            await run_command(f"rm -rf {app_dir}", websocket)
            await run_command(f"rm -f {NGINX_CONF_DIR}/{config['domain']}", websocket)
            await run_command("nginx -s reload", websocket)
            await websocket.send_text(f"App {app_name} deleted successfully!")

        else:
            await websocket.send_text(f"Unknown action: {action}")
    
    except Exception as e:
        await websocket.send_text(f"Error: {str(e)}")
    finally:
        await websocket.close()

@app.get("/app/{app_name}/terminal", response_class=HTMLResponse)
async def terminal(app_name: str, username: str = Depends(get_current_username)):
    return f"""
    <html>
        <head>{HEAD}</head>
        <body>
            <h1>Terminal for {app_name}</h1>
            <div id="terminal"></div>
            <input type="text" id="command" placeholder="Enter command">
            <button onclick="sendCommand()">Send</button>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/xterm/3.14.5/xterm.min.js"></script>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/xterm/3.14.5/xterm.min.css" />
            <script>
                const term = new Terminal();
                term.open(document.getElementById('terminal'));
                
                const ws = new WebSocket(`wss://${{window.location.host}}/ws/terminal/{app_name}`);
                
                ws.onmessage = function(event) {{
                    term.write(event.data);
                }};
                
                function sendCommand() {{
                    const command = document.getElementById('command').value;
                    ws.send(command);
                    document.getElementById('command').value = '';
                }}
            </script>
        </body>
    </html>
    """

@app.websocket("/ws/terminal/{app_name}")
async def websocket_terminal(websocket: WebSocket, app_name: str):
    await websocket.accept()
    
    app_dir = os.path.join(APPS_DIR, app_name)
    
    process = await asyncio.create_subprocess_shell(
        f"tmux attach-session -t {app_name}",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )

    async def read_output():
        while True:
            data = await process.stdout.read(1024)
            if not data:
                break
            await websocket.send_text(data.decode())

    async def read_input():
        while True:
            try:
                data = await websocket.receive_text()
                process.stdin.write(data.encode() + b'\n')
                await process.stdin.drain()
            except WebSocketDisconnect:
                break

    await asyncio.gather(read_output(), read_input())


# Must Run the server with sudo: sudo python3 main.py or sudo hypercorn main:app --bind 0.0.0.0:3001 or sudo uvicorn main:app --host=0.0.0.0 --port=3001
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=os.getenv("PORT", 3001))
