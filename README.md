# wiki-viewer

Standalone local file browser, viewer, and editor. Browse any local directory from a clean web UI.

## Quick start

```bash
cd ~/wiki-viewer
pnpm install
pnpm build
node bin/wiki-viewer.js /path/to/your/files
```

Open http://localhost:3000

## Options

```
wiki-viewer <directory> [options]

  -p, --port <port>   Port to listen on   (default: 3000)
  -H, --host <host>   Host to bind to     (default: localhost)
  --dev               Run in dev mode
```

Examples:
```bash
node bin/wiki-viewer.js ~/notes -p 8080
node bin/wiki-viewer.js ~/notes -p 8080 -H 0.0.0.0   # bind all interfaces
ROOT_DIR=~/notes PORT=8080 HOST=0.0.0.0 pnpm start   # via env vars
```

## Dev mode

```bash
ROOT_DIR=/path/to/files pnpm dev
# or
node bin/wiki-viewer.js /path/to/files --dev
```

## Features

- **Tree browser** — navigate any local directory
- **Viewers**: Markdown (with frontmatter), PDF, images (PNG/JPG/SVG/WebP), video/audio, CSV, source code (with syntax highlighting), DOCX, XLSX, PPTX, Jupyter notebooks, Mermaid diagrams, HTML apps
- **Editor** — rich TipTap editor for Markdown with auto-save
- **File ops** — upload, create folders, delete, drag-to-move
- **Wiki links** — `[[page-name]]` links between markdown files
- **Dark mode** — system-aware theme toggle

## Configuration

| Env var | Description | Default |
|---------|-------------|---------|
| `ROOT_DIR` | Directory to serve | `~/wiki-viewer-files` |
| `PORT` | Port to listen on | `3000` |
| `HOST` | Host/interface to bind | `localhost` |

CLI flags (`-p`, `-H`, `--dev`) override env vars.
