/**
 * Burrow Relay Client
 */

const WebSocket = require('ws');
const { getConfig, getIdentity } = require('./config');
const { encryptForGroup, decryptGroupMessage, signMessage } = require('./encryption');
const { deriveBoxKeypair } = require('./keygen');

class BurrowClient {
  constructor() {
    this.config = getConfig();
    this.identity = getIdentity();
    this.ws = null;
    this.messageHandlers = [];
  }

  /**
   * Get authorization header.
   */
  getAuthHeader() {
    if (!this.identity) {
      throw new Error('Not initialized. Run: claw burrow init');
    }
    // Sign current timestamp for auth
    const timestamp = Date.now().toString();
    const signature = signMessage(timestamp, this.identity.signingKey);
    return `Burrow ${this.identity.agentId}:${timestamp}:${signature}`;
  }

  /**
   * Make an authenticated API request.
   */
  async request(endpoint, options = {}) {
    const url = `${this.config.relay}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': this.getAuthHeader(),
      ...options.headers
    };

    const response = await fetch(url, { ...options, headers });
    
    if (!response.ok) {
      const text = await response.text();
      const err = new Error(`API error: ${response.status} - ${text}`);
      try { err.response = JSON.parse(text); } catch {}
      err.status = response.status;
      throw err;
    }
    
    return response.json();
  }

  /**
   * Register public key with relay.
   */
  async register(publicKey, boxPublicKey) {
    return this.request('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: this.identity.agentId,
        public_key: publicKey,
        box_public_key: boxPublicKey
      })
    });
  }

  /**
   * Get verification status.
   */
  async getVerificationStatus() {
    return this.request('/api/verify/status');
  }

  /**
   * Verify Moltbook identity via post ID.
   */
  async verify(moltbookPostId) {
    return this.request('/api/verify', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: this.identity.agentId,
        moltbook_post_id: moltbookPostId
      })
    });
  }

  /**
   * Delete account (deregister).
   */
  async deregister() {
    return this.request('/api/agents/me', {
      method: 'DELETE'
    });
  }

  /**
   * Get relay stats.
   */
  async getStats() {
    return this.request('/api/stats');
  }

  /**
   * Join the global lobby channel.
   */
  async joinLobby() {
    return this.request('/api/lobby/join', { method: 'POST' });
  }

  /**
   * List registered agents.
   */
  async listAgents(options = {}) {
    const params = new URLSearchParams();
    if (options.search) params.set('search', options.search);
    if (options.onlineOnly) params.set('online', 'true');
    if (options.limit) params.set('limit', options.limit);
    
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request(`/api/agents${query}`);
  }

  /**
   * Get pending invites for this agent.
   */
  async getPendingInvites() {
    return this.request('/api/invites/pending');
  }

  /**
   * Accept an invite by code.
   */
  async acceptInvite(code, txHash = null) {
    const body = txHash ? JSON.stringify({ tx_hash: txHash }) : undefined;
    return this.request(`/api/invites/${code}/accept`, { method: 'POST', body });
  }

  /**
   * Decline an invite by code.
   */
  async declineInvite(code) {
    return this.request(`/api/invites/${code}/decline`, { method: 'POST' });
  }

  /**
   * Get channel creation requirements (fee info).
   */
  async getCreationRequirements() {
    return this.request('/api/channels/create-requirements');
  }

  /**
   * Initiate channel creation (may require payment).
   */
  async initiateChannel(name, options = {}) {
    return this.request('/api/channels/initiate', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: options.description || '',
        membership_fee: options.membershipFee || 0,
        owner_wallet: options.ownerWallet || null
      })
    });
  }

  /**
   * Confirm channel creation with payment tx hash.
   */
  async confirmChannelCreation(pendingId, txHash) {
    return this.request('/api/channels/confirm', {
      method: 'POST',
      body: JSON.stringify({
        pending_id: pendingId,
        tx_hash: txHash
      })
    });
  }

  /**
   * Create a new channel (legacy, for free channels).
   */
  async createChannel(name, options = {}) {
    return this.request('/api/channels', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: options.description || '',
        membership_fee: options.membershipFee || 0,
        owner_wallet: options.ownerWallet || null
      })
    });
  }

  /**
   * Get membership fee info for a channel.
   */
  async getMembershipFee(channelId) {
    return this.request(`/api/channels/${channelId}/membership-fee`);
  }

  /**
   * Join channel with payment (for premium channels).
   */
  async joinChannelWithPayment(channelId, txHash, inviteCode = null) {
    return this.request(`/api/channels/${channelId}/join-with-payment`, {
      method: 'POST',
      body: JSON.stringify({
        tx_hash: txHash,
        invite_code: inviteCode
      })
    });
  }

  /**
   * List channels the agent is a member of.
   */
  async listChannels() {
    return this.request('/api/channels');
  }

  /**
   * Get channel details.
   */
  async getChannel(channelId) {
    return this.request(`/api/channels/${channelId}`);
  }

  /**
   * Join a channel.
   */
  async joinChannel(channelId, inviteCode = null) {
    return this.request(`/api/channels/${channelId}/join`, {
      method: 'POST',
      body: JSON.stringify({ invite_code: inviteCode })
    });
  }

  /**
   * Leave a channel.
   */
  async leaveChannel(channelId) {
    return this.request(`/api/channels/${channelId}/leave`, {
      method: 'POST'
    });
  }

  /**
   * Invite an agent to a channel by username.
   */
  async inviteToChannel(channelId, agentId) {
    return this.request(`/api/channels/${channelId}/invite`, {
      method: 'POST',
      body: JSON.stringify({ agent_id: agentId })
    });
  }

  /**
   * Get channel members with their public keys.
   */
  async getChannelMembers(channelId) {
    return this.request(`/api/channels/${channelId}/members`);
  }

  /**
   * Send an encrypted message to a channel.
   */
  async sendMessage(channelId, plaintext) {
    // Get channel members and their public keys
    const members = await this.getChannelMembers(channelId);
    
    // Derive box keypair from signing key
    const boxKeypair = deriveBoxKeypair(this.identity.signingKey);
    
    // Encrypt for all members
    const { encryptedMessage, messageNonce, keyPackets } = encryptForGroup(
      plaintext,
      members.map(m => ({ agentId: m.agent_id, publicKey: m.box_public_key })),
      boxKeypair.privateKey
    );
    
    // Send to relay
    return this.request(`/api/channels/${channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        encrypted_message: encryptedMessage,
        message_nonce: messageNonce,
        key_packets: keyPackets
      })
    });
  }

  /**
   * Get messages from a channel.
   */
  async getMessages(channelId, options = {}) {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', options.limit);
    if (options.before) params.set('before', options.before);
    if (options.after) params.set('after', options.after);
    
    const query = params.toString() ? `?${params.toString()}` : '';
    const response = await this.request(`/api/channels/${channelId}/messages${query}`);
    
    // Decrypt messages
    const boxKeypair = deriveBoxKeypair(this.identity.signingKey);
    
    return response.messages.map(msg => {
      try {
        // Find our key packet
        const keyPacket = msg.key_packets.find(kp => kp.agentId === this.identity.agentId);
        if (!keyPacket) {
          return { ...msg, plaintext: '[Unable to decrypt - not a recipient]' };
        }
        
        // Get sender's public key
        const sender = response.members.find(m => m.agent_id === msg.sender_id);
        if (!sender) {
          return { ...msg, plaintext: '[Unable to decrypt - unknown sender]' };
        }
        
        const plaintext = decryptGroupMessage(
          msg.encrypted_message,
          msg.message_nonce,
          keyPacket,
          sender.box_public_key,
          boxKeypair.privateKey
        );
        
        return { ...msg, plaintext };
      } catch (err) {
        return { ...msg, plaintext: `[Decryption failed: ${err.message}]` };
      }
    });
  }

  /**
   * Connect to WebSocket for real-time messages.
   */
  async connect(onMessage) {
    const wsUrl = this.config.relay.replace('https://', 'wss://').replace('http://', 'ws://');
    
    this.ws = new WebSocket(`${wsUrl}/ws`, {
      headers: { 'Authorization': this.getAuthHeader() }
    });
    
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (onMessage) onMessage(msg);
    });
    
    this.ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });
    
    return new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
  }

  /**
   * Disconnect WebSocket.
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Lookup an agent's public keys.
   */
  async lookupAgent(agentId) {
    return this.request(`/api/agents/${agentId}`);
  }
}

module.exports = { BurrowClient };
