#!/usr/bin/env node
const path = require('path');
const child_process = require('child_process');

const auroraPath = path.join(__dirname, '..', 'aurora.js');
const args = process.argv.slice(2);

// Spawn a node process that runs aurora.js so require.main === module inside aurora.js
const res = child_process.spawnSync(process.execPath, [auroraPath, ...args], { stdio: 'inherit' });
process.exitCode = res.status;
