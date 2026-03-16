#!/usr/bin/env npx tsx
/**
 * End-to-end: bootstrap → login → fetch schedule → find 7AM CrossFit → book it
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

const date = process.argv[2] || '2026-03-16';
const MEMBERSHIP_ID = process.env.WODIFY_MEMBERSHIP_ID!;

// Step 1: Login
console.log('Logging in...');
const user = await client.login();
console.log(`  ${user.firstName} (UserId=${user.userId})\n`);

// Step 2: Fetch schedule
console.log(`Fetching classes for ${date}...`);
const classes = await client.getClasses(date);
console.log(`  ${classes.length} classes found\n`);

// Step 3: Find the 7AM CrossFit
const target = classes.find((c) => c.Class.Name.includes('7:00 AM'));
if (!target) {
  console.log('No 7:00 AM class found!');
  console.log('Available:');
  for (const c of classes) {
    console.log(`  [${c.Class.Id}] ${c.Class.Name}`);
  }
  process.exit(1);
}

console.log(`Booking: [${target.Class.Id}] ${target.Class.Name}`);
console.log(`  Coach: ${target.Class.Coaches.List.map((c) => c.CoachName).join(', ') || 'TBD'}`);
console.log(`  Available: ${target.Class.Available}\n`);

// Step 4: Book it
const result = await client.bookClass(String(target.Class.Id), MEMBERSHIP_ID);
if (result.Error.HasError) {
  console.log(`FAILED: ${result.Error.ErrorMessage}`);
} else {
  console.log(`BOOKED! ${result.InfoMessage || 'Check Wodify to confirm.'}`);
}
