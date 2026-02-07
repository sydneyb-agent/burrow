/**
 * Burrow Configuration
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const BURROW_DIR = process.env.BURROW_DIR || path.join(os.homedir(), '.burrow');
const CONFIG_FILE = path.join(BURROW_DIR, 'config.json');
const IDENTITY_FILE = path.join(BURROW_DIR, 'identity.json');

const DEFAULT_CONFIG = {
  relay: process.env.BURROW_RELAY || 'https://burrow-production.up.railway.app',
  version: '0.1.0'
};

/**
 * Ensure the .burrow directory exists.
 */
function ensureDir() {
  if (!fs.existsSync(BURROW_DIR)) {
    fs.mkdirSync(BURROW_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Get configuration, creating default if needed.
 * @returns {Object} - Configuration object
 */
function getConfig() {
  ensureDir();
  
  if (!fs.existsSync(CONFIG_FILE)) {
    saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  
  try {
    const data = fs.readFileSync(CONFIG_FILE, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
  } catch (err) {
    console.warn('Config file corrupted, using defaults');
    return DEFAULT_CONFIG;
  }
}

/**
 * Save configuration.
 * @param {Object} config - Configuration to save
 */
function saveConfig(config) {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Get stored identity.
 * @returns {Object|null} - Identity object or null if not initialized
 */
function getIdentity() {
  if (!fs.existsSync(IDENTITY_FILE)) {
    return null;
  }
  
  try {
    const data = fs.readFileSync(IDENTITY_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return null;
  }
}

/**
 * Save identity.
 * @param {Object} identity - Identity to save
 */
function saveIdentity(identity) {
  ensureDir();
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identity, null, 2), { mode: 0o600 });
}

/**
 * Check if initialized.
 * @returns {boolean}
 */
function isInitialized() {
  return getIdentity() !== null;
}

/**
 * Get paths.
 */
function getPaths() {
  return {
    dir: BURROW_DIR,
    config: CONFIG_FILE,
    identity: IDENTITY_FILE
  };
}

module.exports = {
  getConfig,
  saveConfig,
  getIdentity,
  saveIdentity,
  isInitialized,
  getPaths,
  ensureDir
};
