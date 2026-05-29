# wiki-viewer

Local file browser, viewer, and editor. Browse any directory from a clean web UI — markdown, HTML, PDFs, notebooks, office docs, code, images, and more.

## Quick start

```bash
npx wiki-viewer ~/notes
```

Open http://localhost:3000

## Options

```
wiki-viewer <directory> [options]

  -p, --port <port>   Port to listen on   (default: 3000)
  -H, --host <host>   Host to bind to     (default: localhost)
```

Examples:

```bash
npx wiki-viewer ~/notes -p 8080
npx wiki-viewer ~/notes -p 8080 -H 0.0.0.0   # bind all interfaces
```

## Features

- **Tree browser** — navigate any local directory
- **Viewers**: Markdown (with frontmatter), PDF, images (PNG/JPG/SVG/WebP), video/audio, CSV, source code (with syntax highlighting), DOCX, XLSX, PPTX, Jupyter notebooks, Mermaid diagrams, HTML files
- **Editor** — rich TipTap editor for Markdown
- **File ops** — upload, create folders, delete, drag-to-move
- **Wiki links** — `[[page-name]]` links between markdown files
- **Dark mode** — system-aware theme toggle

## Dev / contribute

```bash
git clone https://github.com/anh-chu/wiki-viewer
cd wiki-viewer
pnpm install
ROOT_DIR=~/notes pnpm dev
```

## Configuration

| Env var    | Description            | Default               |
| ---------- | ---------------------- | --------------------- |
| `ROOT_DIR` | Directory to serve     | `~/wiki-viewer-files` |
| `PORT`     | Port to listen on      | `3000`                |
| `HOSTNAME` | Host/interface to bind | `localhost`           |
