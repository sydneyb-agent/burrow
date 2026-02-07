/**
 * USDC Payment Verification
 * 
 * Verifies USDC payments on Base Sepolia testnet.
 */

// Use native fetch (Node 18+)

// Base Sepolia USDC contract
const USDC_CONTRACT = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BASE_SEPOLIA_RPC = process.env.BASE_RPC_URL || 'https://sepolia.base.org';

// ERC-20 Transfer event signature
const TRANSFER_EVENT_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Get transaction receipt from Base Sepolia.
 */
async function getTransactionReceipt(txHash) {
  const response = await fetch(BASE_SEPOLIA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_getTransactionReceipt',
      params: [txHash],
      id: 1
    })
  });

  const data = await response.json();
  return data.result;
}

/**
 * Parse USDC transfer from transaction receipt.
 * Returns { from, to, amount } or null if not a USDC transfer.
 */
function parseUSDCTransfer(receipt) {
  if (!receipt || !receipt.logs) return null;

  for (const log of receipt.logs) {
    // Check if this is the USDC contract
    if (log.address.toLowerCase() !== USDC_CONTRACT.toLowerCase()) continue;
    
    // Check if this is a Transfer event
    if (log.topics[0] !== TRANSFER_EVENT_SIG) continue;
    
    // Parse Transfer(from, to, value)
    const from = '0x' + log.topics[1].slice(26);
    const to = '0x' + log.topics[2].slice(26);
    const amount = parseInt(log.data, 16);
    
    // USDC has 6 decimals
    const amountUSDC = amount / 1_000_000;

    return {
      from: from.toLowerCase(),
      to: to.toLowerCase(),
      amount: amountUSDC,
      txHash: receipt.transactionHash,
      blockNumber: parseInt(receipt.blockNumber, 16),
      status: receipt.status === '0x1' ? 'success' : 'failed'
    };
  }

  return null;
}

/**
 * Verify a USDC payment transaction.
 * 
 * @param {string} txHash - Transaction hash
 * @param {string} expectedTo - Expected recipient address
 * @param {number} expectedAmount - Expected USDC amount
 * @param {string} expectedFrom - Optional: expected sender address
 * @returns {Object} - { valid, transfer, error }
 */
async function verifyPayment(txHash, expectedTo, expectedAmount, expectedFrom = null) {
  try {
    // Get transaction receipt
    const receipt = await getTransactionReceipt(txHash);
    
    if (!receipt) {
      return { valid: false, error: 'Transaction not found or not yet confirmed' };
    }

    if (receipt.status !== '0x1') {
      return { valid: false, error: 'Transaction failed' };
    }

    // Parse USDC transfer
    const transfer = parseUSDCTransfer(receipt);
    
    if (!transfer) {
      return { valid: false, error: 'No USDC transfer found in transaction' };
    }

    // Verify recipient
    if (transfer.to !== expectedTo.toLowerCase()) {
      return { 
        valid: false, 
        error: `Wrong recipient. Expected ${expectedTo}, got ${transfer.to}`,
        transfer 
      };
    }

    // Verify amount (allow small tolerance for rounding)
    if (transfer.amount < expectedAmount - 0.001) {
      return { 
        valid: false, 
        error: `Insufficient amount. Expected ${expectedAmount} USDC, got ${transfer.amount} USDC`,
        transfer 
      };
    }

    // Verify sender if specified
    if (expectedFrom && transfer.from !== expectedFrom.toLowerCase()) {
      return { 
        valid: false, 
        error: `Wrong sender. Expected ${expectedFrom}, got ${transfer.from}`,
        transfer 
      };
    }

    return { valid: true, transfer };
  } catch (err) {
    return { valid: false, error: `Verification failed: ${err.message}` };
  }
}

/**
 * Generate payment instructions.
 */
function getPaymentInstructions(recipientAddress, amountUSDC, reference) {
  return {
    network: 'Base Sepolia (testnet)',
    chain_id: 84532,
    token: 'USDC',
    contract: USDC_CONTRACT,
    recipient: recipientAddress,
    amount: amountUSDC,
    decimals: 6,
    amount_raw: Math.floor(amountUSDC * 1_000_000).toString(),
    reference,
    explorer: `https://sepolia.basescan.org/address/${recipientAddress}`
  };
}

module.exports = {
  verifyPayment,
  getPaymentInstructions,
  parseUSDCTransfer,
  USDC_CONTRACT,
  BASE_SEPOLIA_RPC
};
