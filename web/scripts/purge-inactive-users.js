#!/usr/bin/env node
'use strict';

/**
 * One-shot purge of unverified users inactive 7+ days.
 * Usage:
 *   node scripts/purge-inactive-users.js          # dry-run (counts only)
 *   node scripts/purge-inactive-users.js --apply  # delete for real
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { purgeInactiveUsers, INACTIVE_DAYS } = require('../utils/userCleanup');

const apply = process.argv.includes('--apply');

(async () => {
  const result = await purgeInactiveUsers({ dryRun: !apply });
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Threshold: unverified, older than ${INACTIVE_DAYS} days`);
  console.log(`Found: ${result.found}`);
  if (!apply) {
    if (result.users.length) {
      console.log('Would delete:');
      for (const u of result.users) {
        console.log(`  #${u.id} ${u.username} created=${u.created_at || 'n/a'}`);
      }
    }
    console.log('Run with --apply to delete.');
    process.exit(0);
  }
  console.log(`Deleted: ${result.deleted}`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
