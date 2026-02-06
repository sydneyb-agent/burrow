/**
 * USDC verification unit tests
 * 
 * Note: node-fetch is mocked via __mocks__/node-fetch.js
 */

const { parseUSDCTransfer, getPaymentInstructions, USDC_CONTRACT } = require('../lib/usdc');

describe('USDC Verification', () => {
  describe('parseUSDCTransfer', () => {
    test('should parse a valid USDC transfer receipt', () => {
      // Mock receipt with USDC transfer
      const mockReceipt = {
        transactionHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        blockNumber: '0x100',
        status: '0x1',
        logs: [
          {
            address: USDC_CONTRACT,
            topics: [
              '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', // Transfer event
              '0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // from
              '0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'  // to
            ],
            data: '0x0000000000000000000000000000000000000000000000000000000000989680' // 10 USDC (10 * 10^6)
          }
        ]
      };

      const transfer = parseUSDCTransfer(mockReceipt);

      expect(transfer).toBeDefined();
      expect(transfer.from).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(transfer.to).toBe('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      expect(transfer.amount).toBe(10);
      expect(transfer.status).toBe('success');
    });

    test('should return null for non-USDC transfer', () => {
      const mockReceipt = {
        transactionHash: '0x1234',
        blockNumber: '0x100',
        status: '0x1',
        logs: [
          {
            address: '0x0000000000000000000000000000000000000000', // Not USDC
            topics: [
              '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
              '0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              '0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
            ],
            data: '0x0000000000000000000000000000000000000000000000000000000000989680'
          }
        ]
      };

      const transfer = parseUSDCTransfer(mockReceipt);
      expect(transfer).toBeNull();
    });

    test('should return null for empty logs', () => {
      const mockReceipt = {
        transactionHash: '0x1234',
        blockNumber: '0x100',
        status: '0x1',
        logs: []
      };

      const transfer = parseUSDCTransfer(mockReceipt);
      expect(transfer).toBeNull();
    });

    test('should return null for null receipt', () => {
      const transfer = parseUSDCTransfer(null);
      expect(transfer).toBeNull();
    });

    test('should handle failed transaction', () => {
      const mockReceipt = {
        transactionHash: '0x1234',
        blockNumber: '0x100',
        status: '0x0', // Failed
        logs: [
          {
            address: USDC_CONTRACT,
            topics: [
              '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
              '0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              '0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
            ],
            data: '0x0000000000000000000000000000000000000000000000000000000000989680'
          }
        ]
      };

      const transfer = parseUSDCTransfer(mockReceipt);
      expect(transfer).toBeDefined();
      expect(transfer.status).toBe('failed');
    });

    test('should correctly parse decimal amounts', () => {
      // 0.50 USDC = 500000 (6 decimals)
      const mockReceipt = {
        transactionHash: '0x1234',
        blockNumber: '0x100',
        status: '0x1',
        logs: [
          {
            address: USDC_CONTRACT,
            topics: [
              '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
              '0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              '0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
            ],
            data: '0x000000000000000000000000000000000000000000000000000000000007a120' // 500000 = 0.5 USDC
          }
        ]
      };

      const transfer = parseUSDCTransfer(mockReceipt);
      expect(transfer.amount).toBe(0.5);
    });
  });

  describe('getPaymentInstructions', () => {
    test('should generate valid payment instructions', () => {
      const recipient = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
      const amount = 5.00;
      const reference = 'create-abc123';

      const instructions = getPaymentInstructions(recipient, amount, reference);

      expect(instructions.network).toBe('Base Sepolia (testnet)');
      expect(instructions.chain_id).toBe(84532);
      expect(instructions.token).toBe('USDC');
      expect(instructions.recipient).toBe(recipient);
      expect(instructions.amount).toBe(5.00);
      expect(instructions.decimals).toBe(6);
      expect(instructions.amount_raw).toBe('5000000');
      expect(instructions.reference).toBe(reference);
      expect(instructions.contract).toBe(USDC_CONTRACT);
    });

    test('should handle decimal amounts', () => {
      const instructions = getPaymentInstructions('0x123', 0.50, 'ref');
      expect(instructions.amount_raw).toBe('500000');
    });

    test('should handle zero amount', () => {
      const instructions = getPaymentInstructions('0x123', 0, 'ref');
      expect(instructions.amount_raw).toBe('0');
    });
  });
});
