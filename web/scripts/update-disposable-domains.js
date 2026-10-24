#!/usr/bin/env node
'use strict';

// Rebuilds config/disposable_domains.txt from the public lists used at runtime.
const fs = require('fs');
const path = require('path');
const {
  DISPOSABLE_EMAIL_DOMAINS,
  refreshDisposableDomains
} = require('../config/disposableEmailDomains');

(async () => {
  const before = DISPOSABLE_EMAIL_DOMAINS.size;
  await refreshDisposableDomains();
  const out = path.join(__dirname, '../config/disposable_domains.txt');
  const body =
    '# Merged disposable email domains. Regenerate: node scripts/update-disposable-domains.js\n' +
    [...DISPOSABLE_EMAIL_DOMAINS].sort().join('\n') + '\n';
  fs.writeFileSync(out, body);
  console.log(`disposable_domains.txt: ${before} → ${DISPOSABLE_EMAIL_DOMAINS.size}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
