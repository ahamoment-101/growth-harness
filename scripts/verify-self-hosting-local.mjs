// Actual auth + Worker/D1/Workflow acceptance; a synthetic model avoids paid calls.
process.env.SELF_HOSTING_VERIFY = '1';
await import('./verify-growth-leader-local.mjs');
