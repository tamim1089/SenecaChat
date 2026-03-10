'use strict';
// Legacy shim — the real database module is ./db/index.js
// This file exists only to prevent accidental require('./db') from blowing up.
module.exports = require('./db/index');
