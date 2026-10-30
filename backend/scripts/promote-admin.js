// Gives an existing account the admin (owner) role.
//   1. Sign up on the website with the email you want to use as the owner.
//   2. Run locally (with DATABASE_URL in .env):  npm run admin:promote -- you@example.com
//   Use --demote to turn an admin back into a regular user.
import { closePool, query } from '../db.js';

const args = process.argv.slice(2);
const demote = args.includes('--demote');
const email = args.find((a) => !a.startsWith('--'))?.trim().toLowerCase();

if (!email) {
    console.error('Usage: npm run admin:promote -- you@example.com [--demote]');
    process.exit(1);
}

try {
    const role = demote ? 'user' : 'admin';
    const { rows } = await query(
        'UPDATE users SET role = $1, updated_at = now() WHERE lower(email) = $2 RETURNING email, role',
        [role, email],
    );
    if (rows.length === 0) {
        console.error(`[admin] no account found for ${email}. Sign up on the site first.`);
        process.exitCode = 1;
    } else {
        console.log(`[admin] ${rows[0].email} is now "${rows[0].role}"`);
    }
} catch (err) {
    console.error('[admin] failed:', err.message);
    process.exitCode = 1;
} finally {
    await closePool();
}
