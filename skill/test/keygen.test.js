/**
 * Key generation unit tests
 * 
 * Note: We only test deriveBoxKeypair here since generateKeypair 
 * requires network access to the relay. Full integration tests
 * would cover the complete key generation flow.
 */

// Mock node-fetch before requiring keygen
jest.mock('node-fetch', () => jest.fn());

const nacl = require('tweetnacl');
const { encodeBase64 } = require('tweetnacl-util');

// Import after mocking
const { deriveBoxKeypair } = require('../lib/keygen');

describe('Key Generation', () => {
  describe('deriveBoxKeypair', () => {
    test('should derive box keypair from signing keypair', () => {
      // Generate a signing keypair
      const signKeypair = nacl.sign.keyPair();
      const privateKeyBase64 = encodeBase64(signKeypair.secretKey);

      const boxKeypair = deriveBoxKeypair(privateKeyBase64);

      expect(boxKeypair.publicKey).toBeDefined();
      expect(boxKeypair.privateKey).toBeDefined();
      expect(boxKeypair.publicKey).toHaveLength(44); // Base64 of 32 bytes
      expect(boxKeypair.privateKey).toHaveLength(44);
    });

    test('should derive same keypair from same input', () => {
      const signKeypair = nacl.sign.keyPair();
      const privateKeyBase64 = encodeBase64(signKeypair.secretKey);

      const boxKeypair1 = deriveBoxKeypair(privateKeyBase64);
      const boxKeypair2 = deriveBoxKeypair(privateKeyBase64);

      expect(boxKeypair1.publicKey).toBe(boxKeypair2.publicKey);
      expect(boxKeypair1.privateKey).toBe(boxKeypair2.privateKey);
    });

    test('should derive different keypairs from different inputs', () => {
      const signKeypair1 = nacl.sign.keyPair();
      const signKeypair2 = nacl.sign.keyPair();

      const boxKeypair1 = deriveBoxKeypair(encodeBase64(signKeypair1.secretKey));
      const boxKeypair2 = deriveBoxKeypair(encodeBase64(signKeypair2.secretKey));

      expect(boxKeypair1.publicKey).not.toBe(boxKeypair2.publicKey);
    });

    test('derived keypair should work for encryption', () => {
      const { encryptMessage, decryptMessage } = require('../lib/encryption');
      
      // Alice and Bob each have signing keypairs
      const aliceSign = nacl.sign.keyPair();
      const bobSign = nacl.sign.keyPair();

      // Derive box keypairs
      const aliceBox = deriveBoxKeypair(encodeBase64(aliceSign.secretKey));
      const bobBox = deriveBoxKeypair(encodeBase64(bobSign.secretKey));

      // Encrypt and decrypt
      const message = 'Test message';
      const { ciphertext, nonce } = encryptMessage(
        message,
        bobBox.publicKey,
        aliceBox.privateKey
      );

      const decrypted = decryptMessage(
        ciphertext,
        nonce,
        aliceBox.publicKey,
        bobBox.privateKey
      );

      expect(decrypted).toBe(message);
    });
  });
});
