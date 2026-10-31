// Shared input rules (the Signup page uses the same ones).
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PHONE_RE = /^\+[0-9 (),]{1,25} \d{10}$/; // "<country code> <10 digits>", e.g. "+63 9123456789"
export const PASSWORD_RE = /^(?=(?:.*?\d){2})(?=(?:.*?[!@#$%^&*(),.?":{}|<>]){2}).{8,}$/;
export const PERSON_NAME_RE = /^\p{L}[\p{L}\p{M} .'-]{0,39}$/u;
export const SIZES = ['', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];

export const str = (value) => (typeof value === 'string' ? value.trim() : '');
export const rawStr = (value) => (typeof value === 'string' ? value : '');

export function parsePositiveInt(raw) {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 && n <= 2_147_483_647 ? n : null;
}

// Detects the real image type from the file's first bytes (never trust the client's label).
export function sniffImageType(buf) {
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
}
