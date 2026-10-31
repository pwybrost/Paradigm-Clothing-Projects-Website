import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(backendDir, '..');

// Load .env from the project root for local development (Node >= 20.12 built-in).
// On Vercel the variables come from the project settings, so a missing file is fine.
try {
    process.loadEnvFile(path.join(rootDir, '.env'));
} catch (err) {
    if (err.code !== 'ENOENT') throw err;
}

const env = (name) => (process.env[name] ?? '').trim();
const list = (name) => env(name).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const databaseUrl = env('DATABASE_URL') || env('POSTGRES_URL');

export const config = {
    rootDir,
    backendDir,
    frontendDir: path.join(rootDir, 'frontend'),
    port: Number.parseInt(process.env.PORT ?? '3000', 10),
    // The Neon <-> Vercel integration sets DATABASE_URL (pooled) and POSTGRES_URL.
    databaseUrl,
    isProduction: process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL),
    sessionDays: 30,

    // Public site address used in email links and payment redirects, e.g. https://prdgm.vercel.app
    appUrl: env('APP_URL').replace(/\/+$/, ''),
    // Accounts with these emails become admin (owner) on deploy and at login.
    adminEmails: list('ADMIN_EMAILS'),
    // Secret for signing unsubscribe links. Falls back to a value derived from the database URL.
    appSecret: env('APP_SECRET') || createHash('sha256').update(`prdgm:${databaseUrl}`).digest('hex'),

    // Email (Resend)
    resendApiKey: env('RESEND_API_KEY'),
    emailFrom: env('EMAIL_FROM'),             // e.g. "Paradigm <orders@yourdomain.com>"
    emailReplyTo: env('EMAIL_REPLY_TO'),

    // Payments (PayMongo)
    paymongoSecretKey: env('PAYMONGO_SECRET_KEY'),
    paymongoWebhookSecret: env('PAYMONGO_WEBHOOK_SECRET'),
    paymongoMethods: list('PAYMONGO_METHODS').length ? list('PAYMONGO_METHODS') : ['gcash', 'paymaya', 'card'],
    paymentExpiryMinutes: 120,                // unpaid online orders are cancelled after this

    // Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" when this is set.
    cronSecret: env('CRON_SECRET'),
};

export function requireDatabaseUrl() {
    if (!config.databaseUrl) {
        throw new Error('DATABASE_URL is not set. Add it to .env locally or to the Vercel project environment variables.');
    }
    return config.databaseUrl;
}

// Base URL for links: APP_URL if set, otherwise the host of the current request.
export function baseUrl(req) {
    if (config.appUrl) return config.appUrl;
    return `${req.protocol}://${req.get('host')}`;
}

export const emailEnabled = () => Boolean(config.resendApiKey && config.emailFrom);
export const paymentsEnabled = () => Boolean(config.paymongoSecretKey);
