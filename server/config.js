'use strict';
require('dotenv').config();
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Absolute path to the SQLite database file.
  dbFile: process.env.DB_FILE || path.join(ROOT, 'data', 'udc.db'),

  // JWT signing secret. MUST be overridden in production via env.
  jwtSecret: process.env.JWT_SECRET || 'CHANGE_ME_dev_secret_do_not_use_in_prod',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',

  // bcrypt work factor.
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '10', 10),

  // Default password applied to every seeded user (they must change it on first login).
  defaultPassword: process.env.DEFAULT_PASSWORD || 'Udc@1234',
  // Optional dedicated admin password (falls back to defaultPassword).
  adminPassword: process.env.ADMIN_PASSWORD || process.env.DEFAULT_PASSWORD || 'Udc@1234',

  // Starting value of the LYSAL document sequence.
  startCounter: parseInt(process.env.START_COUNTER || '11251', 10),

  // Document reference year, e.g. LYSAL/11251/2026.
  refYear: parseInt(process.env.REF_YEAR || '2026', 10),

  // Max request body size (attachments are base64 data URLs).
  bodyLimit: process.env.BODY_LIMIT || '25mb',

  root: ROOT,
};

config.isProd = config.nodeEnv === 'production';

// Fail fast in production if secrets were left at their insecure defaults.
if (config.isProd) {
  const problems = [];
  if (config.jwtSecret.startsWith('CHANGE_ME')) problems.push('JWT_SECRET');
  if (problems.length) {
    // eslint-disable-next-line no-console
    console.error(
      '[config] FATAL: insecure default(s) in production: ' + problems.join(', ') +
      '. Set them via environment variables.'
    );
    process.exit(1);
  }
}

module.exports = config;
