<div align="center">
  <img src="public/logo.svg" width="80" height="80" alt="wiki-viewer logo" />
  <h1>wiki-viewer</h1>
  <p><strong>Browse, read, and edit your local files from a clean web UI.</strong></p>
  <p>
    Markdown · PDF · Office docs · Notebooks · Images · Code · and more
  </p>

  <p>
    <!-- npm badge placeholder — will activate once package is published -->
    <!-- <a href="https://www.npmjs.com/package/wiki-viewer"><img src="https://img.shields.io/npm/v/wiki-viewer" alt="npm version" /></a> -->
    <img src="https://img.shields.io/badge/npm-not%20yet%20published-lightgrey" alt="npm not yet published" />
    <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node.js ≥18" />
    <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" />
  </p>
</div>

---

## What is it?

**wiki-viewer** is a zero-config local file browser you run from your terminal. It starts a small web server and lets you navigate, read, and edit any directory on your machine — right from the browser.

No cloud. No accounts. No syncing. Your files stay on your machine.

---

## Features

| Category         | What's included                                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **File viewers** | Markdown (with frontmatter), PDF, images (PNG / JPG / SVG / WebP), video & audio, CSV (table view), source code (syntax highlighting), DOCX, XLSX, PPTX, Jupyter notebooks, Mermaid diagrams, HTML |
| **Editor**       | Rich TipTap editor for Markdown files                                                                                                                                                              |
| **File ops**     | Upload files, create folders, delete, drag-to-move                                                                                                                                                 |
| **Wiki links**   | `[[page-name]]` links between Markdown files                                                                                                                                                       |
| **Dark mode**    | System-aware, with manual toggle                                                                                                                                                                   |
| **HTTPS**        | Self-signed cert via OpenSSL or trusted cert via mkcert — enables service workers on remote hosts                                                                                                  |

---

## Quick start

> **Note:** The npm package is not yet published. Use the [dev setup](#-dev-setup) below to run locally from source. The `npx` commands below will work once the package is on npm.

```bash
# Point it at a directory
npx wiki-viewer ~/notes

# No directory? Pick one in the browser
npx wiki-viewer

# Need HTTPS? (required for service workers on remote hosts)
npx wiki-viewer ~/notes --https
```

Then open **http://localhost:3000** (or **https://localhost:3000** with `--https`).

### Options

```
wiki-viewer [directory] [options]

  directory            Directory to serve  (optional — pick in the browser if omitted)

Options:
  -p, --port <port>   Port to listen on   (default: 3000)
  -H, --host <host>   Host to bind to     (default: localhost)
      --https         Enable HTTPS        (self-signed cert, required for service workers on remote)
  -h, --help          Show this help message
```

**Examples:**

```bash
# Custom port
npx wiki-viewer ~/notes -p 8080

# Bind to all interfaces (accessible on your local network)
npx wiki-viewer ~/notes -H 0.0.0.0

# HTTPS on a custom port
npx wiki-viewer ~/notes --https -p 8443
```

---

## 🔧 Dev setup

Follow these steps to run wiki-viewer from source for local development or contribution.

### Prerequisites

- **Node.js** ≥ 18 — [nodejs.org](https://nodejs.org)
- **pnpm** — [pnpm.io/installation](https://pnpm.io/installation)
  ```bash
  npm install -g pnpm
  ```

### 1 · Clone the repo

```bash
git clone https://github.com/anh-chu/wiki-viewer.git
cd wiki-viewer
```

### 2 · Install dependencies

```bash
pnpm install
```

### 3 · Start the dev server

```bash
# Serve a directory
ROOT_DIR=~/notes pnpm dev

# No directory — pick one in the browser
pnpm dev

# HTTPS dev mode (uses Next.js experimental HTTPS)
ROOT_DIR=~/notes pnpm dev:https
```

Open **http://localhost:3000**.

The dev server supports **hot reload** — changes to source files are reflected instantly.

### Available scripts

| Command          | Description                              |
| ---------------- | ---------------------------------------- |
| `pnpm dev`       | Start Next.js development server         |
| `pnpm dev:https` | Start dev server with experimental HTTPS |
| `pnpm build`     | Build production bundle                  |
| `pnpm start`     | Start production server (after build)    |
| `pnpm wiki`      | Run the CLI entry point (after build)    |

### Environment variables

| Variable   | Description              | Default               |
| ---------- | ------------------------ | --------------------- |
| `ROOT_DIR` | Directory to serve       | `~/wiki-viewer-files` |
| `PORT`     | Port to listen on        | `3000`                |
| `HOSTNAME` | Host / interface to bind | `localhost`           |

---

## 🚀 Local deployment (self-hosted)

Want to run wiki-viewer as a persistent server on your machine or a home server? Here's how.

### Option A — Build and run directly

```bash
# 1. Clone & install
git clone https://github.com/anh-chu/wiki-viewer.git
cd wiki-viewer
pnpm install

# 2. Build the production bundle
pnpm build

# 3. Copy static assets into the standalone output (required step)
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public

# 4. Start the server
ROOT_DIR=/path/to/your/files node .next/standalone/server.js
```

Or use the CLI wrapper (which handles the above automatically):

```bash
node bin/wiki-viewer.js /path/to/your/files
```

### Option B — Run with PM2 (auto-restart on crash / reboot)

```bash
npm install -g pm2

# Start and name the process
pm2 start bin/wiki-viewer.js \
  --name wiki-viewer \
  --node-args="" \
  -- /path/to/your/files --port 3000

# Save so it auto-starts on reboot
pm2 save
pm2 startup   # follow the printed instructions
```

### Option C — systemd service (Linux)

Create `/etc/systemd/system/wiki-viewer.service`:

```ini
[Unit]
Description=wiki-viewer
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/wiki-viewer
ExecStart=/usr/bin/node bin/wiki-viewer.js /path/to/your/files --port 3000 --host 0.0.0.0
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Then enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable wiki-viewer
sudo systemctl start wiki-viewer
sudo systemctl status wiki-viewer
```

### HTTPS on a remote server

If wiki-viewer runs on a remote machine (not `localhost`), service workers require HTTPS. Pass `--https` and wiki-viewer will:

1. Try **mkcert** for a locally-trusted certificate (if installed)
2. Fall back to **OpenSSL** for a self-signed certificate (browser will warn once — click through)

Certificates are stored at `~/.wiki-viewer/certs/` and reused on subsequent starts.

```bash
node bin/wiki-viewer.js /path/to/your/files --https --port 443 --host 0.0.0.0
```

> **Tip:** For a proper public-facing deployment with a real domain, put wiki-viewer behind a reverse proxy (nginx / Caddy) that handles TLS termination instead.

---

## Project structure

```
wiki-viewer/
├── bin/
│   └── wiki-viewer.js      CLI entry point
├── src/
│   ├── app/                Next.js app router pages & API routes
│   ├── components/         React components (viewer, editor, sidebar…)
│   ├── lib/                File system helpers, parsers, utilities
│   ├── stores/             Zustand state stores
│   └── types/              Shared TypeScript types
├── public/
│   └── logo.svg
├── next.config.ts
└── package.json
```

---

## Contributing

1. Fork the repo and create a branch: `git checkout -b my-feature`
2. Make your changes
3. Test with `ROOT_DIR=~/notes pnpm dev`
4. Open a pull request

Bug reports and feature requests welcome via [GitHub Issues](https://github.com/anh-chu/wiki-viewer/issues).

---

## License

MIT © [anh-chu](https://github.com/anh-chu)
