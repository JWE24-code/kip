#!/usr/bin/env node
// Thin CLI wrapper around recentClucks() for the Kip app's Electron main
// process to shell out to — keeps the query in scripts/lib/roost.js as the
// one code path, rather than reimplementing it in ClojureScript.
// Usage: node scripts/recent-clucks.js
const { recentClucks } = require('./lib/roost')

console.log(JSON.stringify(recentClucks(5)))
