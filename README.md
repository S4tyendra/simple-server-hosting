# Server Dashboard

This project is a web-based dashboard for managing and deploying applications on an Ubuntu server. It provides an easy-to-use interface for creating, managing, and monitoring applications running on your server (GCP in this case).

## Features

- Create new applications from Git repositories
- Automatic setup of virtual environments and dependency installation
- Nginx configuration for each application
- Real-time logs and terminal access
- Pull and redeploy applications
- Delete applications
- Domain management and DNS checking

## Prerequisites

- Ubuntu server
- Python 3.7+
- Nginx
- tmux
- Git
- uv (Python package installer and environment manager)

## Installation

1. Clone this repository to your server:
   ```
   git clone https://github.com/s4tyendra/simple-server-hosting.git
   cd simple-server-hosting
   ```

2. Install the required Python packages:
   ```
   sudo pip install fastapi uvicorn dnspython requests --break-system-packages
   ```

3. Install `uv` (uncomment the installation line in the script if not already installed) or run:
   ```
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```

4. Set up your username and password in the `main.py` file:
   ```python
   USERNAME = "yourusername"
   PASSWORD = "yourpassword"
   ```

## Setting up Nginx

1. Install Nginx:
   ```
   sudo apt update
   sudo apt install nginx
   ```

2. Configure Nginx as a reverse proxy:
   Create a new Nginx configuration file:
   ```
   sudo nano /etc/nginx/sites-available/your.doma.in
   ```
   
   Add the following configuration, replacing `your.doma.in` with your actual domain:
   ```nginx
   server {
       listen 80;
       server_name your.doma.in;

       location / {
           proxy_pass http://localhost:3001;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

3. Enable the Nginx configuration:
   ```
   sudo ln -s /etc/nginx/sites-available/your.doma.in /etc/nginx/sites-enabled/
   ```

4. Test the Nginx configuration:
   ```
   sudo nginx -t
   ```

5. If the test is successful, restart Nginx:
   ```
   sudo systemctl restart nginx
   ```

## Adding an A Record

1. Log in to your domain registrar's website or DNS management interface.
2. Locate the DNS management section.
3. Add a new A record:
   - Type: A
   - Host: your subdomain or @ if you are youing a domian without subdomain (or leave blank, depending on your registrar)
   - Value: Your server's public IP address
4. Save the changes. Note that DNS propagation can take up to 48 hours, but it's usually much faster with popular DNS providers like cloudflare.

## Usage

Run the server with sudo:

```
sudo python3 main.py
```
or
```
sudo hypercorn main:app --bind 0.0.0.0:3001
```
or
```
sudo uvicorn main:app --host=0.0.0.0 --port=3001
```

Access the dashboard by navigating to `http://your.doma.in` in your web browser. You'll be prompted for the username and password you set in the configuration.

## Dashboard Features

1. **Create New App**: 
   - Clone a Git repository
   - Set up the application with custom install and start commands
   - Automatically configure Nginx
   - Set up a virtual environment

2. **App Management**: 
   - View app details
   - Check real-time logs
   - Perform actions like pull and redeploy
   - Delete applications

3. **Terminal Access**: 
   - Access a terminal for each application directly from the web interface

4. **Domain Management**: 
   - Check if domains are correctly pointing to your server
   - View server IP and domain status
   - Get instructions for setting up DNS records

## Security Note

This application requires sudo access to run. Make sure to secure your server appropriately and only give access to trusted users.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is open source and available under the [MIT License](LICENSE).

## Troubleshooting

If you encounter any issues or need help, please open an issue on the GitHub repository.