// Sets a new passcode for an existing account, straight in the database.
// Run on your own computer (needs DATABASE_URL in .env):
//   npm run admin:set-password -- pwybrost@addu.edu.ph
// It asks for the new passcode (nothing is saved in files or shell history),
// stores only a scrypt hash, and signs that account out on every device.
import { createInterface } from 'node:readline/promises';
import { closePool, query } from '../db.js';
import { hashPassword } from '../lib/password.js';
import { PASSWORD_RE } from '../lib/validation.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
    console.error('Usage: npm run admin:set-password -- you@example.com');
    process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = (await rl.question(`New passcode for ${email}: `)).trim();
const again = (await rl.question('Repeat passcode: ')).trim();
rl.close();

try {
    if (password !== again) throw new Error('Passcodes do not match.');
    if (!PASSWORD_RE.test(password)) throw new Error('Passcode needs 8+ characters, 2 numbers and 2 symbols.');
    const { rows } = await query(
        'UPDATE users SET password_hash = $2, updated_at = now() WHERE lower(email) = $1 RETURNING id',
        [email, await hashPassword(password)],
    );
    if (!rows[0]) throw new Error(`No account found for ${email}.`);
    await query('DELETE FROM sessions WHERE user_id = $1', [rows[0].id]);
    console.log(`[password] updated for ${email}. Log in again with the new passcode.`);
} catch (err) {
    console.error('[password] failed:', err.message);
    process.exitCode = 1;
} finally {
    await closePool();
}
