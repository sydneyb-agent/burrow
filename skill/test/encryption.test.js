/**
 * Encryption unit tests
 */

const {
  encryptMessage,
  decryptMessage,
  encryptForGroup,
  decryptGroupMessage,
  signMessage,
  verifySignature
} = require('../lib/encryption');

const nacl = require('tweetnacl');
const { encodeBase64 } = require('tweetnacl-util');

// Generate test keypairs
function generateTestBoxKeypair() {
  const keypair = nacl.box.keyPair();
  return {
    publicKey: encodeBase64(keypair.publicKey),
    privateKey: encodeBase64(keypair.secretKey)
  };
}

function generateTestSignKeypair() {
  const keypair = nacl.sign.keyPair();
  return {
    publicKey: encodeBase64(keypair.publicKey),
    privateKey: encodeBase64(keypair.secretKey)
  };
}

describe('Encryption', () => {
  describe('encryptMessage / decryptMessage', () => {
    test('should encrypt and decrypt a message', () => {
      const alice = generateTestBoxKeypair();
      const bob = generateTestBoxKeypair();
      const message = 'Hello, Bob!';

      const { ciphertext, nonce } = encryptMessage(
        message,
        bob.publicKey,
        alice.privateKey
      );

      expect(ciphertext).toBeDefined();
      expect(nonce).toBeDefined();

      const decrypted = decryptMessage(
        ciphertext,
        nonce,
        alice.publicKey,
        bob.privateKey
      );

      expect(decrypted).toBe(message);
    });

    test('should fail to decrypt with wrong key', () => {
      const alice = generateTestBoxKeypair();
      const bob = generateTestBoxKeypair();
      const eve = generateTestBoxKeypair();
      const message = 'Secret message';

      const { ciphertext, nonce } = encryptMessage(
        message,
        bob.publicKey,
        alice.privateKey
      );

      expect(() => {
        decryptMessage(ciphertext, nonce, alice.publicKey, eve.privateKey);
      }).toThrow();
    });

    test('should handle unicode messages', () => {
      const alice = generateTestBoxKeypair();
      const bob = generateTestBoxKeypair();
      const message = '🔐 Secret émoji message 日本語';

      const { ciphertext, nonce } = encryptMessage(
        message,
        bob.publicKey,
        alice.privateKey
      );

      const decrypted = decryptMessage(
        ciphertext,
        nonce,
        alice.publicKey,
        bob.privateKey
      );

      expect(decrypted).toBe(message);
    });

    test('should handle empty messages', () => {
      const alice = generateTestBoxKeypair();
      const bob = generateTestBoxKeypair();
      const message = '';

      const { ciphertext, nonce } = encryptMessage(
        message,
        bob.publicKey,
        alice.privateKey
      );

      const decrypted = decryptMessage(
        ciphertext,
        nonce,
        alice.publicKey,
        bob.privateKey
      );

      expect(decrypted).toBe(message);
    });
  });

  describe('encryptForGroup / decryptGroupMessage', () => {
    test('should encrypt for multiple recipients', () => {
      const sender = generateTestBoxKeypair();
      const recipient1 = { agentId: 'agent1', ...generateTestBoxKeypair() };
      const recipient2 = { agentId: 'agent2', ...generateTestBoxKeypair() };
      const message = 'Group message';

      const { encryptedMessage, messageNonce, keyPackets } = encryptForGroup(
        message,
        [
          { agentId: recipient1.agentId, publicKey: recipient1.publicKey },
          { agentId: recipient2.agentId, publicKey: recipient2.publicKey }
        ],
        sender.privateKey
      );

      expect(encryptedMessage).toBeDefined();
      expect(messageNonce).toBeDefined();
      expect(keyPackets).toHaveLength(2);

      // Recipient 1 can decrypt
      const keyPacket1 = keyPackets.find(kp => kp.agentId === 'agent1');
      const decrypted1 = decryptGroupMessage(
        encryptedMessage,
        messageNonce,
        keyPacket1,
        sender.publicKey,
        recipient1.privateKey
      );
      expect(decrypted1).toBe(message);

      // Recipient 2 can decrypt
      const keyPacket2 = keyPackets.find(kp => kp.agentId === 'agent2');
      const decrypted2 = decryptGroupMessage(
        encryptedMessage,
        messageNonce,
        keyPacket2,
        sender.publicKey,
        recipient2.privateKey
      );
      expect(decrypted2).toBe(message);
    });

    test('should fail with wrong key packet', () => {
      const sender = generateTestBoxKeypair();
      const recipient1 = { agentId: 'agent1', ...generateTestBoxKeypair() };
      const recipient2 = { agentId: 'agent2', ...generateTestBoxKeypair() };
      const message = 'Group message';

      const { encryptedMessage, messageNonce, keyPackets } = encryptForGroup(
        message,
        [
          { agentId: recipient1.agentId, publicKey: recipient1.publicKey },
          { agentId: recipient2.agentId, publicKey: recipient2.publicKey }
        ],
        sender.privateKey
      );

      // Try to use agent1's key packet with agent2's private key
      const keyPacket1 = keyPackets.find(kp => kp.agentId === 'agent1');
      expect(() => {
        decryptGroupMessage(
          encryptedMessage,
          messageNonce,
          keyPacket1,
          sender.publicKey,
          recipient2.privateKey
        );
      }).toThrow();
    });
  });

  describe('signMessage / verifySignature', () => {
    test('should sign and verify a message', () => {
      const keypair = generateTestSignKeypair();
      const message = 'Message to sign';

      const signature = signMessage(message, keypair.privateKey);
      expect(signature).toBeDefined();

      const isValid = verifySignature(message, signature, keypair.publicKey);
      expect(isValid).toBe(true);
    });

    test('should fail verification with wrong key', () => {
      const keypair1 = generateTestSignKeypair();
      const keypair2 = generateTestSignKeypair();
      const message = 'Message to sign';

      const signature = signMessage(message, keypair1.privateKey);
      const isValid = verifySignature(message, signature, keypair2.publicKey);
      expect(isValid).toBe(false);
    });

    test('should fail verification with tampered message', () => {
      const keypair = generateTestSignKeypair();
      const message = 'Original message';

      const signature = signMessage(message, keypair.privateKey);
      const isValid = verifySignature('Tampered message', signature, keypair.publicKey);
      expect(isValid).toBe(false);
    });
  });
});
