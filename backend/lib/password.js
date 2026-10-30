import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

// scrypt cost parameters (N=2^15, r=8 -> 32 MiB of memory per hash).
const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

// Stored format: scrypt$N$r$p$saltBase64$hashBase64
export async function hashPassword(password) {
    const salt = randomBytes(16);
    const key = await scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEMORY });
    return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
    const [algorithm, n, r, p, saltB64, hashB64] = String(stored).split('$');
    if (algorithm !== 'scrypt' || !saltB64 || !hashB64) return false;

    const expected = Buffer.from(hashB64, 'base64');
    const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
        N: Number(n), r: Number(r), p: Number(p), maxmem: MAX_MEMORY,
    });
    return key.length === expected.length && timingSafeEqual(key, expected);
}

// Used when the email doesn't exist so the response time doesn't reveal which emails are registered.
let dummyHash;
export async function burnPasswordCheck(password) {
    dummyHash ??= await hashPassword('paradigm-dummy-password');
    await verifyPassword(password, dummyHash);
}
