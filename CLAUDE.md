# Technical Caveats

## Buildless Architecture (v0.2.0+)

### Architecture Transformation
- Migrated from Next.js+React+HeroUI bloat to minimal Express+Vanilla JavaScript
- Achieves 99.4% reduction in node_modules (746MB → 4.7MB)
- Zero build step required - serve HTML/CSS/JS as-is
- Cold start: ~1 second (was 30+ seconds with Turbopack builds)
- Source code: 1161 lines total (was 3105 LOC)
- Dependencies: 2 prod packages only (express, busboy)

### Backend (Express + Busboy)
- index.js exports a factory function returning an Express Router (library-capable)
- server.js is a thin standalone wrapper that imports index.js and mounts the router
- Path injection prevention: `path.normalize()` + `resolveWithBaseDir()` validates all paths stay within BASE_DIR
- Multipart upload via busboy streaming (no memory buffer for large files)
- File operations: list, upload, download, delete, rename, move, mkdir
- All endpoints return JSON with consistent {ok, value/error} response format
- File type detection via extension mapping (image, video, audio, text, code, archive, document) using `fs.lstat()` (not `fs.stat()`) so symlinks are detected
- Upload filenames sanitized via `path.basename()` — busboy also strips path separators but defense-in-depth matters
- Rename newName sanitized via `path.basename()` — without this, names like `../../evil.txt` escape the parent directory
- Server-side HTML injection uses `escapeJsString()` and `escapeHtml()` for all dynamic values (name, themeKeys, basePath)
- Permission checks via fs.access() with granular read/write flags

### Frontend (Vanilla JavaScript)
- Single index.html with no build step
- app.js handles all UI logic without React/Framework dependencies
- Fetch API for backend communication
- Drag-drop upload with progress tracking
- Preview support: inline images, HTML5 audio/video players
- Breadcrumb navigation with history
- Dark mode via CSS prefers-color-scheme media query and data-theme attribute
### Theme Integration

When embedded in a host app (like agentgui), fsbrowse inherits the host's light/dark theme:

- **localStorage detection**: On load, checks configurable localStorage keys for 'dark' or 'light' values
- **data-theme attribute**: Sets `[data-theme="dark"]` on `<html>` which CSS selectors match
- **Storage event listener**: Reacts to theme changes in real-time across tabs/frames
- **Fallback**: When no localStorage theme is found, falls back to `prefers-color-scheme` media query
- **Override protection**: When `data-theme="light"` is set, the dark media query is blocked via `:root:not([data-theme="light"])`

**Factory option**: `fsbrowse({ themeKeys: 'my-app-theme,theme' })` configures which localStorage keys to check. Default: `'gmgui-theme,theme'`.
- Responsive design: mobile-optimized layout

### Library Usage
- `const fsbrowse = require('fsbrowse')` returns a factory function
- `fsbrowse({ baseDir: '/data' })` returns an Express Router
- Mount at any path: `app.use('/browse', fsbrowse({ baseDir: '/data' }))`
- The router auto-detects its mount path via `req.baseUrl` and injects it into the frontend
- All API calls and static asset references are relative to the mount path
- Multiple instances can be mounted at different paths in the same app
- Options: `baseDir` (filesystem root to serve, defaults to BASE_DIR env or /files)

### Deployment Considerations
- Serve public/ directory as static root via Express
- BASE_DIR environment variable controls accessible filesystem (defaults to /files)
- PORT environment variable overrides default 3000
- BASEPATH (or BASE_PATH) environment variable sets the URL mount path (defaults to /files)
- Set BASEPATH='' to mount at root with no prefix
- CLI flag `--basepath` / `-b` overrides the env var
- No build artifacts, no .next folder, no dist directory needed
- Direct execution: `node server.js`
- Path injection prevention: all paths validated via resolveWithBaseDir() - cannot escape BASE_DIR

### File Viewing Implementation
- `/api/view/:path` endpoint reads files up to 5MB limit for preview
- Binary detection via byte heuristic (null bytes, invalid UTF-8 continuation bytes) — Node's `readFile('utf-8')` never throws on invalid UTF-8, so catch-based detection does not work
- Syntax highlighting via highlight.js CDN (atom-one-dark theme) - not bundled to keep code lean
- File type detection by extension determines rendering strategy:
  - Code (js/ts/py/go/rs/etc): syntax highlighted via hljs.highlightAll()
  - JSON: formatted with JSON.parse/stringify then escaped for safety
  - Text/MD/Log: plaintext in preformatted code blocks
  - Images/Video/Audio: HTML5 native players (img/video/audio elements)
  - Other: raw text up to 10KB with truncation warning
- Modal keyboard shortcuts: ESC to close, Enter to submit in forms
- Drag-download: uses dataTransfer.setData('text/uri-list') for OS integration
- All text content escaped via textContent/escapeHtml()/escapeAttr() to prevent XSS injection
- Frontend `escapeAttr()` used for all values interpolated into HTML attributes (onclick handlers, data attributes)

### Why This Works
- File server needs: REST API for file ops + static HTML UI
- Does NOT need: SSR, JSX compilation, styled-components, TypeScript types, build optimization
- Vanilla JS perfectly adequate for client-side interactivity
- Express sufficient for file operations without Next.js framework overhead

### Testing
- `node test.js` (74), `node test-extended.js` (68), `node test-final.js` (39) — 181 total assertions
- Tests use real Express server instances (no mocks) with temp directories
- Core: all API endpoints, path traversal, XSS injection, binary detection, symlink handling, CLI parsing, BASEPATH routing
- Extended: all fileTypeMap categories, broken symlinks, empty dirs, escape functions, factory defaults, static serving, multibyte UTF-8, download headers, upload/rename/move edge cases, BASEPATH env precedence, frontend utility functions
- Final: rename newName traversal fix, sort order, special filenames (spaces/unicode/parens), multi-file upload, return values, 5MB boundary, directory rename/move, concurrent requests, factory null/undefined
