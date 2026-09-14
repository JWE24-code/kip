// Test preload: point the workspace root at a throwaway dir so the suite never
// writes into the developer's real app-state dir (~/.local/state/kip). Loaded
// via `node --require ./scripts/test/_state.js --test …`; the env var is
// inherited by every spawned script, so subprocess tests stay isolated too.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

process.env.KIP_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-workspace-test-'))
