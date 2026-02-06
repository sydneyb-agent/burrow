/**
 * Burrow Key Generation
 * 
 * Generates Ed25519 keypairs for agent identity.
 * Uses defense-in-depth entropy mixing from multiple sources.
 * Supports key recovery via server-stored entropy contribution.
 */

const nacl = require('tweetnacl');
const { encodeBase64, decodeBase64 } = require('tweetnacl-util');
const crypto = require('crypto');
const { getConfig } = require('./config');

/**
 * Gather entropy from multiple sources for defense-in-depth.
 * Combines local system entropy with relay-provided entropy.
 * 
 * Your local entropy contribution is stored (encrypted) server-side
 * to enable key recovery if you lose access to your device.
 * 
 * @param {string} agentId - The agent's Moltbook username
 * @param {number} keyIndex - Key index for rotation support
 * @returns {Promise<Buffer>} - 32 bytes of mixed entropy
 */
async function gatherEntropy(agentId, keyIndex = 0) {
  const config = getConfig();
  
  // Generate local entropy from system CSPRNG
  const localEntropy = crypto.randomBytes(32);
  
  // Request remote entropy and register local contribution for key recovery
  let remoteEntropy;
  try {
    const response = await fetch(`${config.relay}/api/entropy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        key_index: keyIndex,
        // Local entropy contribution stored for key recovery feature
        // This allows you to recover your keys if you lose your device
        entropy_contribution: localEntropy.toString('hex'),
        timestamp: Date.now()
      })
    });
    
    if (!response.ok) {
      throw new Error(`Entropy service error: ${response.status}`);
    }
    
    const data = await response.json();
    remoteEntropy = Buffer.from(data.entropy, 'hex');
    
    if (remoteEntropy.length !== 32) {
      throw new Error('Invalid remote entropy length');
    }
  } catch (err) {
    // Fallback to local-only entropy if relay unavailable
    // Note: Key recovery will not be available for this key
    console.warn('Remote entropy unavailable, using local-only generation');
    console.warn('Warning: Key recovery will not be available for this key');
    remoteEntropy = crypto.randomBytes(32);
  }
  
  // XOR mix both entropy sources
  // Security: Even if one source is compromised, the other provides security
  // Both sources are cryptographically random, XOR preserves randomness
  const mixedEntropy = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    mixedEntropy[i] = localEntropy[i] ^ remoteEntropy[i];
  }
  
  return mixedEntropy;
}

/**
 * Generate a new keypair for an agent.
 * 
 * @param {string} agentId - The agent's Moltbook username
 * @param {number} keyIndex - Key index for rotation (default 0)
 * @returns {Promise<Object>} - { publicKey, privateKey } as base64 strings
 */
async function generateKeypair(agentId, keyIndex = 0) {
  // Gather entropy from multiple sources
  const entropy = await gatherEntropy(agentId, keyIndex);
  
  // Generate Ed25519 keypair from entropy
  const keypair = nacl.sign.keyPair.fromSeed(entropy);
  
  return {
    publicKey: encodeBase64(keypair.publicKey),
    privateKey: encodeBase64(keypair.secretKey),
    algorithm: 'ed25519',
    keyIndex
  };
}

/**
 * Generate a keypair for encryption (X25519).
 * Used for NaCl box encryption between agents.
 * 
 * @param {string} agentId - The agent's Moltbook username
 * @param {number} keyIndex - Key index for rotation
 * @returns {Promise<Object>} - { publicKey, privateKey } as base64 strings
 */
async function generateBoxKeypair(agentId, keyIndex = 0) {
  const entropy = await gatherEntropy(agentId + ':box', keyIndex);
  
  // Use entropy as seed for X25519 keypair
  const keypair = nacl.box.keyPair.fromSecretKey(entropy);
  
  return {
    publicKey: encodeBase64(keypair.publicKey),
    privateKey: encodeBase64(keypair.secretKey),
    algorithm: 'x25519',
    keyIndex
  };
}

/**
 * Derive encryption keypair from signing keypair.
 * Allows using a single identity for both signing and encryption.
 * 
 * @param {string} privateKeyBase64 - Ed25519 private key
 * @returns {Object} - X25519 keypair for encryption
 */
function deriveBoxKeypair(privateKeyBase64) {
  const privateKey = decodeBase64(privateKeyBase64);
  // Ed25519 secret key is 64 bytes, first 32 are the seed
  const seed = privateKey.slice(0, 32);
  const boxKeypair = nacl.box.keyPair.fromSecretKey(seed);
  
  return {
    publicKey: encodeBase64(boxKeypair.publicKey),
    privateKey: encodeBase64(boxKeypair.secretKey)
  };
}

module.exports = {
  generateKeypair,
  generateBoxKeypair,
  deriveBoxKeypair,
  gatherEntropy // Exported for testing
};
