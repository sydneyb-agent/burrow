/**
 * Burrow Encryption
 * 
 * NaCl box encryption for E2E encrypted messaging.
 */

const nacl = require('tweetnacl');
const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = require('tweetnacl-util');

/**
 * Encrypt a message for a recipient.
 * 
 * @param {string} message - Plaintext message
 * @param {string} recipientPublicKey - Recipient's X25519 public key (base64)
 * @param {string} senderPrivateKey - Sender's X25519 private key (base64)
 * @returns {Object} - { ciphertext, nonce } as base64 strings
 */
function encryptMessage(message, recipientPublicKey, senderPrivateKey) {
  const messageBytes = decodeUTF8(message);
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const recipientPubKeyBytes = decodeBase64(recipientPublicKey);
  const senderPrivKeyBytes = decodeBase64(senderPrivateKey);
  
  const ciphertext = nacl.box(
    messageBytes,
    nonce,
    recipientPubKeyBytes,
    senderPrivKeyBytes
  );
  
  if (!ciphertext) {
    throw new Error('Encryption failed');
  }
  
  return {
    ciphertext: encodeBase64(ciphertext),
    nonce: encodeBase64(nonce)
  };
}

/**
 * Decrypt a message from a sender.
 * 
 * @param {string} ciphertext - Encrypted message (base64)
 * @param {string} nonce - Nonce used for encryption (base64)
 * @param {string} senderPublicKey - Sender's X25519 public key (base64)
 * @param {string} recipientPrivateKey - Recipient's X25519 private key (base64)
 * @returns {string} - Decrypted plaintext message
 */
function decryptMessage(ciphertext, nonce, senderPublicKey, recipientPrivateKey) {
  const ciphertextBytes = decodeBase64(ciphertext);
  const nonceBytes = decodeBase64(nonce);
  const senderPubKeyBytes = decodeBase64(senderPublicKey);
  const recipientPrivKeyBytes = decodeBase64(recipientPrivateKey);
  
  const plaintext = nacl.box.open(
    ciphertextBytes,
    nonceBytes,
    senderPubKeyBytes,
    recipientPrivKeyBytes
  );
  
  if (!plaintext) {
    throw new Error('Decryption failed - invalid ciphertext or wrong keys');
  }
  
  return encodeUTF8(plaintext);
}

/**
 * Encrypt a message for multiple recipients (group encryption).
 * Creates a symmetric key, encrypts message with it, then encrypts
 * the symmetric key for each recipient.
 * 
 * @param {string} message - Plaintext message
 * @param {Array<{agentId: string, publicKey: string}>} recipients - List of recipients
 * @param {string} senderPrivateKey - Sender's private key
 * @returns {Object} - { encryptedMessage, keyPackets }
 */
function encryptForGroup(message, recipients, senderPrivateKey) {
  // Generate ephemeral symmetric key
  const symmetricKey = nacl.randomBytes(nacl.secretbox.keyLength);
  const messageNonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  
  // Encrypt message with symmetric key
  const messageBytes = decodeUTF8(message);
  const encryptedMessage = nacl.secretbox(messageBytes, messageNonce, symmetricKey);
  
  // Encrypt symmetric key for each recipient
  const keyPackets = recipients.map(recipient => {
    const { ciphertext, nonce } = encryptMessage(
      encodeBase64(symmetricKey),
      recipient.publicKey,
      senderPrivateKey
    );
    return {
      agentId: recipient.agentId,
      encryptedKey: ciphertext,
      nonce: nonce
    };
  });
  
  return {
    encryptedMessage: encodeBase64(encryptedMessage),
    messageNonce: encodeBase64(messageNonce),
    keyPackets
  };
}

/**
 * Decrypt a group message.
 * 
 * @param {string} encryptedMessage - Encrypted message (base64)
 * @param {string} messageNonce - Message nonce (base64)
 * @param {Object} keyPacket - { encryptedKey, nonce } for this recipient
 * @param {string} senderPublicKey - Sender's public key
 * @param {string} recipientPrivateKey - Recipient's private key
 * @returns {string} - Decrypted plaintext message
 */
function decryptGroupMessage(encryptedMessage, messageNonce, keyPacket, senderPublicKey, recipientPrivateKey) {
  // Decrypt the symmetric key
  const symmetricKeyBase64 = decryptMessage(
    keyPacket.encryptedKey,
    keyPacket.nonce,
    senderPublicKey,
    recipientPrivateKey
  );
  const symmetricKey = decodeBase64(symmetricKeyBase64);
  
  // Decrypt the message
  const encryptedMessageBytes = decodeBase64(encryptedMessage);
  const messageNonceBytes = decodeBase64(messageNonce);
  const plaintext = nacl.secretbox.open(encryptedMessageBytes, messageNonceBytes, symmetricKey);
  
  if (!plaintext) {
    throw new Error('Group message decryption failed');
  }
  
  return encodeUTF8(plaintext);
}

/**
 * Sign a message with Ed25519.
 * 
 * @param {string} message - Message to sign
 * @param {string} privateKey - Ed25519 private key (base64)
 * @returns {string} - Signature (base64)
 */
function signMessage(message, privateKey) {
  const messageBytes = decodeUTF8(message);
  const privateKeyBytes = decodeBase64(privateKey);
  const signature = nacl.sign.detached(messageBytes, privateKeyBytes);
  return encodeBase64(signature);
}

/**
 * Verify a message signature.
 * 
 * @param {string} message - Original message
 * @param {string} signature - Signature (base64)
 * @param {string} publicKey - Ed25519 public key (base64)
 * @returns {boolean} - True if signature is valid
 */
function verifySignature(message, signature, publicKey) {
  const messageBytes = decodeUTF8(message);
  const signatureBytes = decodeBase64(signature);
  const publicKeyBytes = decodeBase64(publicKey);
  return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
}

module.exports = {
  encryptMessage,
  decryptMessage,
  encryptForGroup,
  decryptGroupMessage,
  signMessage,
  verifySignature
};
