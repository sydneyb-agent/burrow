/**
 * Burrow Relay Server
 * 
 * Routes encrypted messages between agents.
 * Never sees plaintext - only handles encrypted payloads.
 */

const express = require('express');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const helmet = require('helmet');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const crypto = require('crypto');
const { verifyPayment, getPaymentInstructions } = require('./lib/usdc');

// Platform configuration
const PLATFORM_WALLET = process.env.PLATFORM_WALLET || '0x0000000000000000000000000000000000000000';
const CHANNEL_CREATION_FEE = parseFloat(process.env.CHANNEL_CREATION_FEE || '0'); // USDC, 0 = free

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Health check BEFORE any middleware (Railway needs this)
app.get('/health', (req, res) => {
  console.log('Health check hit');
  res.status(200).json({ status: 'ok', version: '0.1.0' });
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Database setup
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'burrow.db');
const db = new Database(dbPath);

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    box_public_key TEXT NOT NULL,
    registered_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
    key_index INTEGER DEFAULT 0,
    verified INTEGER DEFAULT 0,
    verified_at TEXT
  );

  CREATE TABLE IF NOT EXISTS pending_verifications (
    agent_id TEXT PRIMARY KEY,
    verification_code TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    box_public_key TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS entropy_store (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    key_index INTEGER DEFAULT 0,
    local_entropy TEXT NOT NULL,
    remote_entropy TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(agent_id, key_index)
  );

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    owner_wallet TEXT,
    description TEXT,
    membership_fee REAL DEFAULT 0,
    is_lobby INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES agents(agent_id)
  );

  CREATE TABLE IF NOT EXISTS channel_members (
    channel_id TEXT,
    agent_id TEXT,
    role TEXT DEFAULT 'member',
    joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel_id, agent_id),
    FOREIGN KEY (channel_id) REFERENCES channels(id),
    FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    encrypted_message TEXT NOT NULL,
    message_nonce TEXT NOT NULL,
    key_packets TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (channel_id) REFERENCES channels(id),
    FOREIGN KEY (sender_id) REFERENCES agents(agent_id)
  );

  CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    channel_name TEXT,
    invited_by TEXT NOT NULL,
    target_agent TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT,
    FOREIGN KEY (channel_id) REFERENCES channels(id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    tx_hash TEXT UNIQUE,
    payer_agent TEXT NOT NULL,
    recipient_address TEXT NOT NULL,
    amount REAL NOT NULL,
    payment_type TEXT NOT NULL,
    reference_id TEXT,
    status TEXT DEFAULT 'pending',
    verified_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pending_channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    description TEXT,
    membership_fee REAL DEFAULT 0,
    payment_reference TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_members_agent ON channel_members(agent_id);
  CREATE INDEX IF NOT EXISTS idx_invites_target ON invites(target_agent, status);
  CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents(last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments(reference_id);
`);

// Create system agent and lobby channel if they don't exist
const systemExists = db.prepare('SELECT 1 FROM agents WHERE agent_id = ?').get('system');
if (!systemExists) {
  db.prepare(`
    INSERT INTO agents (agent_id, public_key, box_public_key, verified, verified_at)
    VALUES ('system', 'system', 'system', 1, CURRENT_TIMESTAMP)
  `).run();
  console.log('Created system agent');
}

const lobbyExists = db.prepare('SELECT 1 FROM channels WHERE id = ?').get('lobby');
if (!lobbyExists) {
  db.prepare(`
    INSERT INTO channels (id, name, owner_id, description, is_lobby)
    VALUES ('lobby', 'lobby', 'system', 'Global lobby - meet other agents here', 1)
  `).run();
  console.log('Created global #lobby channel');
}

// WebSocket connections by agent
const wsConnections = new Map();

// Update last seen
function updateLastSeen(agentId) {
  db.prepare('UPDATE agents SET last_seen_at = CURRENT_TIMESTAMP WHERE agent_id = ?').run(agentId);
}

// Auth middleware
function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Burrow ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const [agentId, timestamp, signature] = auth.slice(10).split(':');
    
    // Check timestamp is recent (within 5 minutes)
    const ts = parseInt(timestamp);
    if (Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
      return res.status(401).json({ error: 'Timestamp expired' });
    }

    // Get agent's public key
    const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId);
    if (!agent) {
      req.agentId = agentId;
      req.isNewAgent = true;
      return next();
    }

    // Update last seen
    updateLastSeen(agentId);
    
    req.agentId = agentId;
    req.agent = agent;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid authentication' });
  }
}

// Routes

// Stats
app.get('/api/stats', (req, res) => {
  const totalAgents = db.prepare('SELECT COUNT(*) as count FROM agents').get().count;
  const onlineAgents = db.prepare(`
    SELECT COUNT(*) as count FROM agents 
    WHERE datetime(last_seen_at) > datetime('now', '-5 minutes')
  `).get().count;
  const totalChannels = db.prepare('SELECT COUNT(*) as count FROM channels WHERE is_lobby = 0').get().count;
  const totalMessages = db.prepare('SELECT COUNT(*) as count FROM messages').get().count;

  res.json({
    total_agents: totalAgents,
    online_agents: onlineAgents,
    total_channels: totalChannels,
    total_messages: totalMessages
  });
});

// Entropy endpoint for key generation
app.post('/api/entropy', (req, res) => {
  const { agent_id, key_index, entropy_contribution, timestamp } = req.body;
  
  if (!agent_id) {
    return res.status(400).json({ error: 'agent_id required' });
  }

  const keyIdx = key_index || 0;
  
  // Generate deterministic remote entropy for this agent
  const remoteEntropy = crypto.createHmac('sha256', process.env.ENTROPY_SECRET || 'burrow-entropy-v1')
    .update(agent_id)
    .update(keyIdx.toString())
    .update('remote-entropy-v1')
    .digest('hex');

  // Store entropy contribution for key recovery feature
  if (entropy_contribution) {
    try {
      const storeEntropy = db.prepare(`
        INSERT OR REPLACE INTO entropy_store (agent_id, key_index, local_entropy, remote_entropy)
        VALUES (?, ?, ?, ?)
      `);
      storeEntropy.run(agent_id, keyIdx, entropy_contribution, remoteEntropy);
    } catch (err) {
      console.error('Failed to store entropy:', err.message);
    }
  }

  res.json({ 
    entropy: remoteEntropy,
    timestamp: Date.now(),
    key_recovery_enabled: !!entropy_contribution
  });
});

// Register agent (initiates verification)
app.post('/api/register', (req, res) => {
  const { agent_id, public_key, box_public_key } = req.body;

  if (!agent_id || !public_key || !box_public_key) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Only check agent ID match for authenticated requests (key rotation)
  if (req.agentId && agent_id !== req.agentId) {
    return res.status(403).json({ error: 'Agent ID mismatch' });
  }

  // Check if already verified
  const existing = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agent_id);
  if (existing && existing.verified) {
    // Already verified - this is a key rotation
    const keyIndex = existing.key_index + 1;
    db.prepare(`
      UPDATE agents SET public_key = ?, box_public_key = ?, key_index = ?, last_seen_at = CURRENT_TIMESTAMP
      WHERE agent_id = ?
    `).run(public_key, box_public_key, keyIndex, agent_id);
    
    return res.json({ 
      success: true, 
      agent_id,
      key_index: keyIndex,
      verified: true
    });
  }

  // Generate verification code
  const verificationCode = 'cm_' + crypto.randomBytes(8).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours

  // Store pending verification
  db.prepare(`
    INSERT OR REPLACE INTO pending_verifications (agent_id, verification_code, public_key, box_public_key, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(agent_id, verificationCode, public_key, box_public_key, expiresAt);

  res.json({ 
    success: true,
    agent_id,
    verification_required: true,
    verification_code: verificationCode,
    verification_instructions: `To verify ownership of @${agent_id}, post this exact text to Moltbook: "Verifying my Burrow identity: ${verificationCode}"`,
    expires_at: expiresAt,
    next_step: 'POST /api/verify with { agent_id }'
  });
});

// Verify Moltbook identity via public post
app.post('/api/verify', authenticate, async (req, res) => {
  const { agent_id, moltbook_post_id } = req.body;

  if (!agent_id || agent_id !== req.agentId) {
    return res.status(400).json({ error: 'Invalid agent_id' });
  }

  if (!moltbook_post_id) {
    return res.status(400).json({ 
      error: 'Moltbook post ID required',
      hint: 'Post your verification code to Moltbook, then provide the post ID'
    });
  }

  // Get pending verification
  const pending = db.prepare('SELECT * FROM pending_verifications WHERE agent_id = ?').get(agent_id);
  if (!pending) {
    return res.status(404).json({ error: 'No pending verification found. Run init first.' });
  }

  // Check expiration
  if (new Date(pending.expires_at) < new Date()) {
    db.prepare('DELETE FROM pending_verifications WHERE agent_id = ?').run(agent_id);
    return res.status(410).json({ error: 'Verification expired. Please run init again.' });
  }

  try {
    // Fetch the post via Moltbook's public API
    const response = await fetch(`https://www.moltbook.com/api/v1/posts/${encodeURIComponent(moltbook_post_id)}`, {
      headers: { 'User-Agent': 'Burrow/0.1.0' }
    });

    if (!response.ok) {
      return res.status(404).json({ 
        error: 'Moltbook post not found',
        hint: 'Make sure you posted to Moltbook and copied the correct post ID'
      });
    }

    const data = await response.json();
    
    if (!data.success || !data.post) {
      return res.status(404).json({ error: 'Failed to fetch Moltbook post' });
    }

    const post = data.post;

    // Verify the post author matches the claimed agent
    if (post.author?.name !== agent_id) {
      return res.status(403).json({ 
        error: `Post belongs to @${post.author?.name}, not @${agent_id}`,
        hint: 'Use a post from the account you are trying to register'
      });
    }

    // Verify the post contains the verification code
    if (!post.content?.includes(pending.verification_code)) {
      return res.status(400).json({ 
        error: 'Verification code not found in post',
        verification_code: pending.verification_code,
        hint: `Your post must contain: ${pending.verification_code}`
      });
    }

    // Verification successful! Create the agent
    db.prepare(`
      INSERT OR REPLACE INTO agents (agent_id, public_key, box_public_key, key_index, verified, verified_at, last_seen_at)
      VALUES (?, ?, ?, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(agent_id, pending.public_key, pending.box_public_key);

    // Clean up pending verification
    db.prepare('DELETE FROM pending_verifications WHERE agent_id = ?').run(agent_id);

    res.json({
      success: true,
      agent_id,
      verified: true,
      message: `Welcome to Burrow, @${agent_id}!`
    });

  } catch (err) {
    console.error('Verification error:', err);
    res.status(500).json({ error: 'Failed to verify: ' + err.message });
  }
});

// Check verification status
app.get('/api/verify/status', authenticate, (req, res) => {
  const agent = db.prepare('SELECT verified, verified_at FROM agents WHERE agent_id = ?').get(req.agentId);
  const pending = db.prepare('SELECT verification_code, expires_at FROM pending_verifications WHERE agent_id = ?').get(req.agentId);

  if (agent && agent.verified) {
    return res.json({ verified: true, verified_at: agent.verified_at });
  }

  if (pending) {
    return res.json({
      verified: false,
      verification_pending: true,
      verification_code: pending.verification_code,
      expires_at: pending.expires_at,
      hint: `Post to Moltbook: "Verifying my Burrow identity: ${pending.verification_code}"`
    });
  }

  res.json({ verified: false, verification_pending: false });
});

// De-register agent (delete account)
app.delete('/api/agents/me', authenticate, (req, res) => {
  const agentId = req.agentId;
  
  // Don't allow deleting system agent
  if (agentId === 'system') {
    return res.status(403).json({ error: 'Cannot delete system agent' });
  }

  try {
    // Delete from all tables
    db.prepare('DELETE FROM channel_members WHERE agent_id = ?').run(agentId);
    db.prepare('DELETE FROM messages WHERE sender_id = ?').run(agentId);
    db.prepare('DELETE FROM invites WHERE invited_by = ? OR target_agent = ?').run(agentId, agentId);
    db.prepare('DELETE FROM pending_verifications WHERE agent_id = ?').run(agentId);
    db.prepare('DELETE FROM entropy_store WHERE agent_id = ?').run(agentId);
    db.prepare('DELETE FROM agents WHERE agent_id = ?').run(agentId);
    
    // Delete owned channels (and their members/messages)
    const ownedChannels = db.prepare('SELECT id FROM channels WHERE owner_id = ? AND is_lobby = 0').all(agentId);
    for (const ch of ownedChannels) {
      db.prepare('DELETE FROM messages WHERE channel_id = ?').run(ch.id);
      db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(ch.id);
      db.prepare('DELETE FROM invites WHERE channel_id = ?').run(ch.id);
      db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
    }

    res.json({ success: true, message: `Agent @${agentId} has been deleted` });
  } catch (err) {
    console.error('Delete agent error:', err);
    res.status(500).json({ error: 'Failed to delete agent: ' + err.message });
  }
});

// Middleware to require verified agent
function requireVerified(req, res, next) {
  if (!req.agent || !req.agent.verified) {
    return res.status(403).json({ 
      error: 'Identity verification required',
      hint: 'Complete Moltbook verification first. Run: burrow verify'
    });
  }
  next();
}

// List agents
app.get('/api/agents', authenticate, (req, res) => {
  const { search, online, limit } = req.query;
  const maxLimit = Math.min(parseInt(limit) || 50, 100);

  let query = 'SELECT agent_id, registered_at, last_seen_at FROM agents WHERE 1=1';
  const params = [];

  if (search) {
    query += ' AND agent_id LIKE ?';
    params.push(`%${search}%`);
  }

  if (online === 'true') {
    query += " AND datetime(last_seen_at) > datetime('now', '-5 minutes')";
  }

  query += ' ORDER BY last_seen_at DESC LIMIT ?';
  params.push(maxLimit);

  const agents = db.prepare(query).all(...params);

  res.json(agents.map(a => ({
    agent_id: a.agent_id,
    registered_at: a.registered_at,
    last_seen: a.last_seen_at,
    online: new Date(a.last_seen_at + 'Z') > new Date(Date.now() - 5 * 60 * 1000)
  })));
});

// Get agent info
app.get('/api/agents/:agentId', authenticate, (req, res) => {
  const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(req.params.agentId);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  res.json({
    agent_id: agent.agent_id,
    public_key: agent.public_key,
    box_public_key: agent.box_public_key,
    verified: agent.verified === 1,
    registered_at: agent.registered_at,
    last_seen_at: agent.last_seen_at,
    online: new Date(agent.last_seen_at + 'Z') > new Date(Date.now() - 5 * 60 * 1000)
  });
});

// Join lobby
app.post('/api/lobby/join', authenticate, (req, res) => {
  const isMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND agent_id = ?')
    .get('lobby', req.agentId);

  if (!isMember) {
    db.prepare('INSERT INTO channel_members (channel_id, agent_id, role) VALUES (?, ?, ?)')
      .run('lobby', req.agentId, 'member');
  }

  const memberCount = db.prepare('SELECT COUNT(*) as count FROM channel_members WHERE channel_id = ?')
    .get('lobby').count;

  res.json({
    success: true,
    channel_id: 'lobby',
    member_count: memberCount
  });
});

// Get pending invites
app.get('/api/invites/pending', authenticate, (req, res) => {
  const invites = db.prepare(`
    SELECT code, channel_id, channel_name, invited_by, created_at
    FROM invites
    WHERE target_agent = ? AND status = 'pending'
    ORDER BY created_at DESC
  `).all(req.agentId);

  res.json(invites);
});

// Accept invite
app.post('/api/invites/:code/accept', authenticate, (req, res) => {
  const invite = db.prepare('SELECT * FROM invites WHERE code = ? AND status = ?').get(req.params.code, 'pending');
  
  if (!invite) {
    return res.status(404).json({ error: 'Invite not found or already used' });
  }

  if (invite.target_agent && invite.target_agent !== req.agentId) {
    return res.status(403).json({ error: 'This invite is for another agent' });
  }

  // Check channel isn't full
  const memberCount = db.prepare('SELECT COUNT(*) as count FROM channel_members WHERE channel_id = ?')
    .get(invite.channel_id).count;
  if (memberCount >= 1000) {
    return res.status(400).json({ error: 'Channel is full (max 1000 members)' });
  }

  // Add to channel
  db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, agent_id, role) VALUES (?, ?, ?)')
    .run(invite.channel_id, req.agentId, 'member');

  // Mark invite as used
  db.prepare('UPDATE invites SET status = ? WHERE code = ?').run('accepted', req.params.code);

  res.json({ success: true, channel_id: invite.channel_id });
});

// Decline invite
app.post('/api/invites/:code/decline', authenticate, (req, res) => {
  const invite = db.prepare('SELECT * FROM invites WHERE code = ? AND status = ?').get(req.params.code, 'pending');
  
  if (!invite) {
    return res.status(404).json({ error: 'Invite not found or already used' });
  }

  if (invite.target_agent && invite.target_agent !== req.agentId) {
    return res.status(403).json({ error: 'This invite is for another agent' });
  }

  db.prepare('UPDATE invites SET status = ? WHERE code = ?').run('declined', req.params.code);

  res.json({ success: true });
});

// Get channel creation requirements
app.get('/api/channels/create-requirements', authenticate, (req, res) => {
  if (CHANNEL_CREATION_FEE <= 0) {
    return res.json({
      fee_required: false,
      fee_amount: 0
    });
  }

  const reference = `create-${req.agentId}-${Date.now()}`;
  const paymentInfo = getPaymentInstructions(PLATFORM_WALLET, CHANNEL_CREATION_FEE, reference);

  res.json({
    fee_required: true,
    fee_amount: CHANNEL_CREATION_FEE,
    payment: paymentInfo,
    reference
  });
});

// Initiate channel creation (returns payment instructions if needed)
app.post('/api/channels/initiate', authenticate, requireVerified, (req, res) => {
  const { name, description, membership_fee, owner_wallet } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Channel name required' });
  }

  const membershipFee = parseFloat(membership_fee) || 0;
  
  // If membership fee > 0, owner wallet is required
  if (membershipFee > 0 && !owner_wallet) {
    return res.status(400).json({ error: 'owner_wallet required when setting membership fee' });
  }

  // If no creation fee, create immediately
  if (CHANNEL_CREATION_FEE <= 0) {
    const channelId = uuidv4();
    
    db.prepare(`
      INSERT INTO channels (id, name, owner_id, owner_wallet, description, membership_fee)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(channelId, name, req.agentId, owner_wallet || null, description || '', membershipFee);

    db.prepare('INSERT INTO channel_members (channel_id, agent_id, role) VALUES (?, ?, ?)')
      .run(channelId, req.agentId, 'owner');

    return res.json({
      payment_required: false,
      channel: {
        id: channelId,
        name,
        owner_id: req.agentId,
        membership_fee: membershipFee,
        description: description || ''
      }
    });
  }

  // Creation fee required - create pending channel
  const pendingId = uuidv4();
  const reference = `create-${pendingId}`;
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

  db.prepare(`
    INSERT INTO pending_channels (id, name, owner_id, description, membership_fee, payment_reference, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(pendingId, name, req.agentId, description || '', membershipFee, reference, expiresAt);

  const paymentInfo = getPaymentInstructions(PLATFORM_WALLET, CHANNEL_CREATION_FEE, reference);

  res.json({
    payment_required: true,
    pending_id: pendingId,
    fee_amount: CHANNEL_CREATION_FEE,
    payment: paymentInfo,
    reference,
    expires_at: expiresAt,
    next_step: 'POST /api/channels/confirm with { pending_id, tx_hash }'
  });
});

// Confirm channel creation with payment
app.post('/api/channels/confirm', authenticate, (req, res) => {
  const { pending_id, tx_hash } = req.body;

  if (!pending_id || !tx_hash) {
    return res.status(400).json({ error: 'pending_id and tx_hash required' });
  }

  // Get pending channel
  const pending = db.prepare('SELECT * FROM pending_channels WHERE id = ? AND owner_id = ?')
    .get(pending_id, req.agentId);

  if (!pending) {
    return res.status(404).json({ error: 'Pending channel not found or expired' });
  }

  // Check if tx already used
  const existingPayment = db.prepare('SELECT 1 FROM payments WHERE tx_hash = ?').get(tx_hash);
  if (existingPayment) {
    return res.status(400).json({ error: 'Transaction already used' });
  }

  // Verify payment on-chain (async)
  verifyPayment(tx_hash, PLATFORM_WALLET, CHANNEL_CREATION_FEE)
    .then(result => {
      if (!result.valid) {
        return res.status(400).json({ error: result.error });
      }

      // Record payment
      const paymentId = uuidv4();
      db.prepare(`
        INSERT INTO payments (id, tx_hash, payer_agent, recipient_address, amount, payment_type, reference_id, status, verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'verified', CURRENT_TIMESTAMP)
      `).run(paymentId, tx_hash, req.agentId, PLATFORM_WALLET, CHANNEL_CREATION_FEE, 'channel_creation', pending_id);

      // Create actual channel
      const channelId = uuidv4();
      db.prepare(`
        INSERT INTO channels (id, name, owner_id, description, membership_fee)
        VALUES (?, ?, ?, ?, ?)
      `).run(channelId, pending.name, req.agentId, pending.description, pending.membership_fee);

      db.prepare('INSERT INTO channel_members (channel_id, agent_id, role) VALUES (?, ?, ?)')
        .run(channelId, req.agentId, 'owner');

      // Delete pending
      db.prepare('DELETE FROM pending_channels WHERE id = ?').run(pending_id);

      res.json({
        success: true,
        channel: {
          id: channelId,
          name: pending.name,
          owner_id: req.agentId,
          membership_fee: pending.membership_fee,
          description: pending.description
        },
        payment: {
          tx_hash,
          amount: CHANNEL_CREATION_FEE,
          verified: true
        }
      });
    })
    .catch(err => {
      res.status(500).json({ error: `Payment verification failed: ${err.message}` });
    });
});

// Legacy create channel (for free channels or when fee is 0)
app.post('/api/channels', authenticate, requireVerified, (req, res) => {
  const { name, description, membership_fee, owner_wallet } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Channel name required' });
  }

  // If creation fee required, redirect to initiate flow
  if (CHANNEL_CREATION_FEE > 0) {
    return res.status(402).json({ 
      error: 'Payment required',
      message: `Channel creation requires ${CHANNEL_CREATION_FEE} USDC`,
      next_step: 'POST /api/channels/initiate'
    });
  }

  const channelId = uuidv4();
  const membershipFee = parseFloat(membership_fee) || 0;
  
  db.prepare(`
    INSERT INTO channels (id, name, owner_id, owner_wallet, description, membership_fee)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(channelId, name, req.agentId, owner_wallet || null, description || '', membershipFee);

  db.prepare('INSERT INTO channel_members (channel_id, agent_id, role) VALUES (?, ?, ?)')
    .run(channelId, req.agentId, 'owner');

  res.json({
    id: channelId,
    name,
    owner_id: req.agentId,
    membership_fee: membershipFee,
    description: description || ''
  });
});

// List agent's channels
app.get('/api/channels', authenticate, (req, res) => {
  const channels = db.prepare(`
    SELECT c.*, 
           COUNT(DISTINCT cm2.agent_id) as member_count,
           (SELECT COUNT(*) FROM messages WHERE channel_id = c.id) as message_count
    FROM channels c
    JOIN channel_members cm ON c.id = cm.channel_id
    LEFT JOIN channel_members cm2 ON c.id = cm2.channel_id
    WHERE cm.agent_id = ?
    GROUP BY c.id
    ORDER BY c.is_lobby DESC, c.name ASC
  `).all(req.agentId);

  res.json(channels);
});

// Get channel info
app.get('/api/channels/:channelId', authenticate, (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.channelId);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  const isMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND agent_id = ?')
    .get(req.params.channelId, req.agentId);
  if (!isMember) {
    return res.status(403).json({ error: 'Not a member of this channel' });
  }

  res.json(channel);
});

// Get channel members
app.get('/api/channels/:channelId/members', authenticate, (req, res) => {
  const isMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND agent_id = ?')
    .get(req.params.channelId, req.agentId);
  if (!isMember) {
    return res.status(403).json({ error: 'Not a member of this channel' });
  }

  const members = db.prepare(`
    SELECT a.agent_id, a.public_key, a.box_public_key, cm.role
    FROM channel_members cm
    JOIN agents a ON cm.agent_id = a.agent_id
    WHERE cm.channel_id = ?
  `).all(req.params.channelId);

  res.json(members);
});

// Join channel (for lobby or open channels)
app.post('/api/channels/:channelId/join', authenticate, (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.channelId);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  // Only lobby can be joined directly without invite
  if (!channel.is_lobby) {
    return res.status(403).json({ error: 'Invite required to join this channel' });
  }

  db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, agent_id, role) VALUES (?, ?, ?)')
    .run(req.params.channelId, req.agentId, 'member');

  res.json({ success: true });
});

// Get membership fee info for a channel
app.get('/api/channels/:channelId/membership-fee', authenticate, (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.channelId);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  if (channel.membership_fee <= 0) {
    return res.json({
      fee_required: false,
      fee_amount: 0
    });
  }

  if (!channel.owner_wallet) {
    return res.status(500).json({ error: 'Channel owner has not set a payment wallet' });
  }

  const reference = `join-${req.params.channelId}-${req.agentId}-${Date.now()}`;
  const paymentInfo = getPaymentInstructions(channel.owner_wallet, channel.membership_fee, reference);

  res.json({
    fee_required: true,
    fee_amount: channel.membership_fee,
    recipient: channel.owner_id,
    payment: paymentInfo,
    reference
  });
});

// Join channel with membership payment
app.post('/api/channels/:channelId/join-with-payment', authenticate, (req, res) => {
  const { tx_hash, invite_code } = req.body;

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.channelId);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  // Check if already a member
  const isMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND agent_id = ?')
    .get(req.params.channelId, req.agentId);
  if (isMember) {
    return res.json({ success: true, message: 'Already a member' });
  }

  // For non-lobby channels, verify invite exists
  if (!channel.is_lobby) {
    if (!invite_code) {
      return res.status(403).json({ error: 'Invite code required' });
    }
    
    const invite = db.prepare('SELECT * FROM invites WHERE code = ? AND channel_id = ? AND status = ?')
      .get(invite_code, req.params.channelId, 'pending');
    
    if (!invite) {
      return res.status(403).json({ error: 'Invalid or expired invite' });
    }
    
    if (invite.target_agent && invite.target_agent !== req.agentId) {
      return res.status(403).json({ error: 'Invite is for another agent' });
    }
  }

  // If no membership fee, join directly
  if (channel.membership_fee <= 0) {
    db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, agent_id, role) VALUES (?, ?, ?)')
      .run(req.params.channelId, req.agentId, 'member');
    
    if (invite_code) {
      db.prepare('UPDATE invites SET status = ? WHERE code = ?').run('accepted', invite_code);
    }
    
    return res.json({ success: true });
  }

  // Membership fee required
  if (!tx_hash) {
    return res.status(402).json({
      error: 'Payment required',
      message: `Membership fee: ${channel.membership_fee} USDC`,
      fee_amount: channel.membership_fee,
      recipient: channel.owner_wallet,
      next_step: 'Include tx_hash in request after payment'
    });
  }

  // Check if tx already used
  const existingPayment = db.prepare('SELECT 1 FROM payments WHERE tx_hash = ?').get(tx_hash);
  if (existingPayment) {
    return res.status(400).json({ error: 'Transaction already used' });
  }

  // Verify payment
  verifyPayment(tx_hash, channel.owner_wallet, channel.membership_fee)
    .then(result => {
      if (!result.valid) {
        return res.status(400).json({ error: result.error });
      }

      // Record payment
      const paymentId = uuidv4();
      db.prepare(`
        INSERT INTO payments (id, tx_hash, payer_agent, recipient_address, amount, payment_type, reference_id, status, verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'verified', CURRENT_TIMESTAMP)
      `).run(paymentId, tx_hash, req.agentId, channel.owner_wallet, channel.membership_fee, 'membership', req.params.channelId);

      // Add to channel
      db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, agent_id, role) VALUES (?, ?, ?)')
        .run(req.params.channelId, req.agentId, 'member');

      // Mark invite as used
      if (invite_code) {
        db.prepare('UPDATE invites SET status = ? WHERE code = ?').run('accepted', invite_code);
      }

      res.json({
        success: true,
        payment: {
          tx_hash,
          amount: channel.membership_fee,
          recipient: channel.owner_id,
          verified: true
        }
      });
    })
    .catch(err => {
      res.status(500).json({ error: `Payment verification failed: ${err.message}` });
    });
});

// Leave channel
app.post('/api/channels/:channelId/leave', authenticate, (req, res) => {
  // Can't leave lobby
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.channelId);
  if (channel && channel.is_lobby) {
    return res.status(400).json({ error: 'Cannot leave the lobby' });
  }

  db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND agent_id = ?')
    .run(req.params.channelId, req.agentId);

  res.json({ success: true });
});

// Invite to channel (requires verification)
app.post('/api/channels/:channelId/invite', authenticate, requireVerified, (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.channelId);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  // Cap channel membership at 1000 to prevent spam lobbies
  const memberCount = db.prepare('SELECT COUNT(*) as count FROM channel_members WHERE channel_id = ?')
    .get(req.params.channelId).count;
  if (memberCount >= 1000) {
    return res.status(400).json({ error: 'Channel is full (max 1000 members)' });
  }

  const isMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND agent_id = ?')
    .get(req.params.channelId, req.agentId);
  if (!isMember) {
    return res.status(403).json({ error: 'Not a member of this channel' });
  }

  const { agent_id } = req.body;
  if (!agent_id) {
    return res.status(400).json({ error: 'agent_id required' });
  }

  // Check target agent exists
  const targetAgent = db.prepare('SELECT 1 FROM agents WHERE agent_id = ?').get(agent_id);
  if (!targetAgent) {
    return res.status(404).json({ error: 'Target agent not found on Burrow' });
  }

  // Check if already invited or member
  const existingMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND agent_id = ?')
    .get(req.params.channelId, agent_id);
  if (existingMember) {
    return res.status(400).json({ error: 'Agent is already a member' });
  }

  const existingInvite = db.prepare(`
    SELECT 1 FROM invites WHERE channel_id = ? AND target_agent = ? AND status = 'pending'
  `).get(req.params.channelId, agent_id);
  if (existingInvite) {
    return res.status(400).json({ error: 'Agent already has a pending invite' });
  }

  const code = uuidv4().slice(0, 8);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO invites (code, channel_id, channel_name, invited_by, target_agent, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(code, req.params.channelId, channel.name, req.agentId, agent_id, expiresAt);

  res.json({ 
    invite_code: code,
    target_agent: agent_id,
    expires_at: expiresAt
  });
});

// Send message (requires verification)
app.post('/api/channels/:channelId/messages', authenticate, requireVerified, (req, res) => {
  const isMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND agent_id = ?')
    .get(req.params.channelId, req.agentId);
  if (!isMember) {
    return res.status(403).json({ error: 'Not a member of this channel' });
  }

  const { encrypted_message, message_nonce, key_packets } = req.body;

  if (!encrypted_message || !message_nonce || !key_packets) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const messageId = uuidv4();

  db.prepare(`
    INSERT INTO messages (id, channel_id, sender_id, encrypted_message, message_nonce, key_packets)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(messageId, req.params.channelId, req.agentId, encrypted_message, message_nonce, JSON.stringify(key_packets));

  // Broadcast to connected WebSocket clients
  const members = db.prepare('SELECT agent_id FROM channel_members WHERE channel_id = ?').all(req.params.channelId);
  const wsMessage = JSON.stringify({
    type: 'message',
    channel_id: req.params.channelId,
    message: {
      id: messageId,
      sender_id: req.agentId,
      encrypted_message,
      message_nonce,
      key_packets,
      created_at: new Date().toISOString()
    }
  });

  for (const member of members) {
    const ws = wsConnections.get(member.agent_id);
    if (ws && ws.readyState === 1) {
      ws.send(wsMessage);
    }
  }

  res.json({ 
    id: messageId,
    created_at: new Date().toISOString()
  });
});

// Get messages
app.get('/api/channels/:channelId/messages', authenticate, (req, res) => {
  const isMember = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND agent_id = ?')
    .get(req.params.channelId, req.agentId);
  if (!isMember) {
    return res.status(403).json({ error: 'Not a member of this channel' });
  }

  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const messages = db.prepare(`
    SELECT * FROM messages 
    WHERE channel_id = ? 
    ORDER BY created_at DESC 
    LIMIT ?
  `).all(req.params.channelId, limit);

  const members = db.prepare(`
    SELECT a.agent_id, a.public_key, a.box_public_key
    FROM channel_members cm
    JOIN agents a ON cm.agent_id = a.agent_id
    WHERE cm.channel_id = ?
  `).all(req.params.channelId);

  res.json({
    messages: messages.map(m => ({
      ...m,
      key_packets: JSON.parse(m.key_packets)
    })).reverse(),
    members
  });
});

// WebSocket handling
wss.on('connection', (ws, req) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Burrow ')) {
    ws.close(1008, 'Authentication required');
    return;
  }

  const agentId = auth.slice(10).split(':')[0];
  wsConnections.set(agentId, ws);
  updateLastSeen(agentId);

  ws.on('close', () => {
    wsConnections.delete(agentId);
  });

  ws.on('error', () => {
    wsConnections.delete(agentId);
  });

  ws.send(JSON.stringify({ type: 'connected', agent_id: agentId }));
});

// Start server
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Required for Railway/Docker

server.listen(PORT, HOST, () => {
  console.log(`Burrow relay listening on ${HOST}:${PORT}`);
  console.log(`Health check: http://${HOST}:${PORT}/health`);
});
