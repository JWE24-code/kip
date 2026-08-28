#!/usr/bin/env node
// Content-free dump of the skills Peck can see, for CLI introspection and the
// app's Skills settings panel (electron.skills → :skillsList). Secrets and
// filesystem paths are deliberately NOT included.
//
//   node scripts/skills-list.js
//   -> [{ name, description, whenToUse, source, network, enabled, parameters }, ...]
//
// Set KIP_COOP_ROOT to point at a graph other than this repo's ./coop.
require('dotenv').config()
const { describeSkills } = require('./lib/skills')
const { DEFAULT_VAULT_ROOT } = require('./lib/paths')

console.log(JSON.stringify(describeSkills(DEFAULT_VAULT_ROOT)))
