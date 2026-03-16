#!/usr/bin/env npx tsx
/**
 * Smoke test — uses the actual WodifyClient to fetch classes and optionally login.
 * Usage: npx tsx test-smoke.ts [YYYY-MM-DD]
 */
import { config } from 'dotenv';
config();

import { WodifyClient } from './src/wodify-client.js';

const client = new WodifyClient({
  gymSubdomain: process.env.WODIFY_GYM_SUBDOMAIN!,
  email: process.env.WODIFY_EMAIL!,
  password: process.env.WODIFY_PASSWORD!,
  customerId: process.env.WODIFY_CUSTOMER_ID!,
  locationId: parseInt(process.env.WODIFY_LOCATION_ID!, 10),
  customerHex: process.env.WODIFY_CUSTOMER_HEX!,
  membershipId: process.env.WODIFY_MEMBERSHIP_ID!,
});

const date = process.argv[2] || (() => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
})();

console.log(`Fetching classes for ${date}...\n`);

const classes = await client.getClasses(date);
if (classes.length === 0) {
  console.log('No classes found.');
} else {
  for (const item of classes) {
    const c = item.Class;
    const coaches = c.Coaches.List.map((co) => co.CoachName).join(', ') || 'TBD';
    const status = c.IsCancelled ? 'CANCELLED' : c.IsFull ? 'FULL' : `${c.Available} avail`;
    console.log(`[${c.Id}] ${c.Name}`);
    console.log(`  ${c.StartTime.slice(0, 5)}–${c.EndDateTime.split('T')[1]?.slice(0, 5)}  |  Coach: ${coaches}  |  ${status}`);
    console.log();
  }
  console.log(`Total: ${classes.length} classes`);
}

// Test login
console.log('\n--- Login test ---');
const user = await client.login();
console.log(`Logged in as ${user.firstName} (UserId=${user.userId}, Customer=${user.customer})`);
