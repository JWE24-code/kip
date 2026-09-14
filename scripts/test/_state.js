// Test preload: point the workspace root at a throwaway dir so the suite never
// writes into the developer's real app-state dir (~/.local/state/kip). Loaded
// via `node --require ./scripts/test/_state.js --test …`; the env var is
// inherited by every spawned script, so subprocess tests stay isolated too.
//
// Don't clobber a value the runner already set: the test runner spawns a child
// per test file (and worker threads inherit the preload too), and re-running
// this file would hand each thread a different throwaway dir — so a writer
// worker and its reader would disagree about where meta.db lives.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

if (!process.env.KIP_WORKSPACE_ROOT) {
  process.env.KIP_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kip-workspace-test-'))
}
