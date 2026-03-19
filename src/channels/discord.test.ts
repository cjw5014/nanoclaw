import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- discord.js mock ---

type Handler = (...args: any[]) => any;

const clientRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('discord.js', () => {
  const Events = {
    MessageCreate: 'messageCreate',
    ClientReady: 'ready',
    Error: 'error',
    ThreadCreate: 'threadCreate',
    ThreadDelete: 'threadDelete',
    ThreadUpdate: 'threadUpdate',
  };

  const GatewayIntentBits = {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    DirectMessages: 8,
  };

  class MockClient {
    eventHandlers = new Map<string, Handler[]>();
    user: any = { id: '999888777', tag: 'Andy#1234' };
    private _ready = false;

    constructor(_opts: any) {
      clientRef.current = this;
    }

    on(event: string, handler: Handler) {
      const existing = this.eventHandlers.get(event) || [];
      existing.push(handler);
      this.eventHandlers.set(event, existing);
      return this;
    }

    once(event: string, handler: Handler) {
      return this.on(event, handler);
    }

    async login(_token: string) {
      this._ready = true;
      // Fire the ready event — pass `this` as the readyClient (mirrors discord.js behavior)
      const readyHandlers = this.eventHandlers.get('ready') || [];
      for (const h of readyHandlers) {
        await h(this);
      }
    }

    isReady() {
      return this._ready;
    }

    channels = {
      fetch: vi.fn().mockResolvedValue({
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      }),
    };

    // Minimal guilds.cache needed by joinExistingThreads
    guilds = {
      cache: new Map([
        ['guild1', {
          id: 'guild1',
          channels: {
            fetch: vi.fn().mockResolvedValue(new Map([
              ['1234567890123456', {
                id: '1234567890123456',
                threads: {
                  fetchActive: vi.fn().mockResolvedValue({ threads: new Map() }),
                },
              }],
            ])),
          },
        }],
      ]),
    };

    destroy() {
      this._ready = false;
    }
  }

  // Mock TextChannel type
  class TextChannel {}

  const ChannelType = {
    GuildText: 0,
    DM: 1,
    GuildVoice: 2,
    GroupDM: 3,
    GuildCategory: 4,
    GuildAnnouncement: 5,
    AnnouncementThread: 10,
    PublicThread: 11,
    PrivateThread: 12,
    GuildStageVoice: 13,
    GuildForum: 15,
  };

  return {
    Client: MockClient,
    Events,
    GatewayIntentBits,
    TextChannel,
    ChannelType,
  };
});

import { DiscordChannel } from './discord.js';
import { ChannelOpts } from './registry.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<ChannelOpts>,
): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'dc:1234567890123456': {
        name: 'Test Server #general',
        folder: 'test-server',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    registerEphemeralGroup: vi.fn(),
    unregisterEphemeralGroup: vi.fn(),
    ...overrides,
  };
}

function createMessage(overrides: {
  channelId?: string;
  content?: string;
  authorId?: string;
  authorUsername?: string;
  authorDisplayName?: string;
  memberDisplayName?: string;
  isBot?: boolean;
  guildName?: string;
  channelName?: string;
  messageId?: string;
  createdAt?: Date;
  attachments?: Map<string, any>;
  reference?: { messageId?: string };
  mentionsBotId?: boolean;
  channelType?: number;
  parentChannelId?: string;
}) {
  const channelId = overrides.channelId ?? '1234567890123456';
  const authorId = overrides.authorId ?? '55512345';
  const botId = '999888777'; // matches mock client user id

  const mentionsMap = new Map();
  if (overrides.mentionsBotId) {
    mentionsMap.set(botId, { id: botId });
  }

  // Default to GuildText (0) unless overridden
  const channelType = overrides.channelType ?? 0;
  const isThread = channelType === 11 || channelType === 12 || channelType === 10;

  return {
    channelId,
    type: 0, // MessageType.Default
    id: overrides.messageId ?? 'msg_001',
    content: overrides.content ?? 'Hello everyone',
    createdAt: overrides.createdAt ?? new Date('2024-01-01T00:00:00.000Z'),
    author: {
      id: authorId,
      username: overrides.authorUsername ?? 'alice',
      displayName: overrides.authorDisplayName ?? 'Alice',
      bot: overrides.isBot ?? false,
    },
    member: overrides.memberDisplayName
      ? { displayName: overrides.memberDisplayName }
      : null,
    guild: overrides.guildName
      ? { name: overrides.guildName }
      : null,
    channel: {
      type: channelType,
      name: overrides.channelName ?? 'general',
      parentId: isThread ? (overrides.parentChannelId ?? '1234567890123456') : undefined,
      messages: {
        fetch: vi.fn().mockResolvedValue({
          author: { username: 'Bob', displayName: 'Bob' },
          member: { displayName: 'Bob' },
        }),
      },
    },
    mentions: {
      users: mentionsMap,
    },
    attachments: overrides.attachments ?? new Map(),
    reference: overrides.reference ?? null,
  };
}

function currentClient() {
  return clientRef.current;
}

async function triggerMessage(message: any) {
  const handlers = currentClient().eventHandlers.get('messageCreate') || [];
  for (const h of handlers) await h(message);
}

// --- Tests ---

describe('DiscordChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when client is ready', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers message handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();

      expect(currentClient().eventHandlers.has('messageCreate')).toBe(true);
      expect(currentClient().eventHandlers.has('error')).toBe(true);
      expect(currentClient().eventHandlers.has('ready')).toBe(true);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered channel', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello everyone',
        guildName: 'Test Server',
        channelName: 'general',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'Test Server #general',
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          id: 'msg_001',
          chat_jid: 'dc:1234567890123456',
          sender: '55512345',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered channels', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: '9999999999999999',
        content: 'Unknown channel',
        guildName: 'Other Server',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:9999999999999999',
        expect.any(String),
        expect.any(String),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores bot messages', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({ isBot: true, content: 'I am a bot' });
      await triggerMessage(msg);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('uses member displayName when available (server nickname)', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hi',
        memberDisplayName: 'Alice Nickname',
        authorDisplayName: 'Alice Global',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({ sender_name: 'Alice Nickname' }),
      );
    });

    it('falls back to author displayName when no member', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hi',
        memberDisplayName: undefined,
        authorDisplayName: 'Alice Global',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({ sender_name: 'Alice Global' }),
      );
    });

    it('uses sender name for DM chats (no guild)', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:1234567890123456': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello',
        guildName: undefined,
        authorDisplayName: 'Alice',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'Alice',
      );
    });

    it('uses guild name + channel name for server messages', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello',
        guildName: 'My Server',
        channelName: 'bot-chat',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'My Server #bot-chat',
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates <@botId> mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '<@999888777> what time is it?',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '@Andy hello <@999888777>',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      // Should NOT prepend @Andy — already starts with trigger
      // But the <@botId> should still be stripped
      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy hello',
        }),
      );
    });

    it('does not translate when bot is not mentioned', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'hello everyone',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: 'hello everyone',
        }),
      );
    });

    it('handles <@!botId> (nickname mention format)', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '<@!999888777> check this',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy check this',
        }),
      );
    });
  });

  // --- Attachments ---

  describe('attachments', () => {
    it('stores image attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'photo.png', contentType: 'image/png' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Image: photo.png]',
        }),
      );
    });

    it('stores video attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'clip.mp4', contentType: 'video/mp4' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Video: clip.mp4]',
        }),
      );
    });

    it('stores file attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'report.pdf', contentType: 'application/pdf' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[File: report.pdf]',
        }),
      );
    });

    it('includes text content with attachments', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'photo.jpg', contentType: 'image/jpeg' }],
      ]);
      const msg = createMessage({
        content: 'Check this out',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: 'Check this out\n[Image: photo.jpg]',
        }),
      );
    });

    it('handles multiple attachments', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'a.png', contentType: 'image/png' }],
        ['att2', { name: 'b.txt', contentType: 'text/plain' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Image: a.png]\n[File: b.txt]',
        }),
      );
    });
  });

  // --- Reply context ---

  describe('reply context', () => {
    it('includes reply author in content', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'I agree with that',
        reference: { messageId: 'original_msg_id' },
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Reply to Bob] I agree with that',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via channel', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('dc:1234567890123456', 'Hello');

      const fetchedChannel = await currentClient().channels.fetch('1234567890123456');
      expect(currentClient().channels.fetch).toHaveBeenCalledWith('1234567890123456');
    });

    it('strips dc: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('dc:9876543210', 'Test');

      expect(currentClient().channels.fetch).toHaveBeenCalledWith('9876543210');
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      currentClient().channels.fetch.mockRejectedValueOnce(
        new Error('Channel not found'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('dc:1234567890123456', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      // Don't connect — client is null
      await channel.sendMessage('dc:1234567890123456', 'No client');

      // No error, no API call
    });

    it('splits messages exceeding 2000 characters', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const mockChannel = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn(),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      const longText = 'x'.repeat(3000);
      await channel.sendMessage('dc:1234567890123456', longText);

      expect(mockChannel.send).toHaveBeenCalledTimes(2);
      expect(mockChannel.send).toHaveBeenNthCalledWith(1, 'x'.repeat(2000));
      expect(mockChannel.send).toHaveBeenNthCalledWith(2, 'x'.repeat(1000));
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns dc: JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('dc:1234567890123456')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing indicator when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const mockChannel = {
        send: vi.fn(),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.setTyping('dc:1234567890123456', true);

      expect(mockChannel.sendTyping).toHaveBeenCalled();
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('dc:1234567890123456', false);

      // channels.fetch should NOT be called
      expect(currentClient().channels.fetch).not.toHaveBeenCalled();
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      // Don't connect
      await channel.setTyping('dc:1234567890123456', true);

      // No error
    });
  });

  // --- Thread support ---

  describe('thread support', () => {
    it('delivers thread message using parent channel registration', async () => {
      // Parent channel 1234567890123456 is registered; thread has its own channelId
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: '9999000000000001', // thread's own channelId
        channelType: 11, // PublicThread
        parentChannelId: '1234567890123456', // registered parent
        content: 'Thread message',
        guildName: 'Server',
        channelName: 'my-thread',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:9999000000000001',
        expect.objectContaining({
          chat_jid: 'dc:9999000000000001',
          content: 'Thread message',
        }),
      );
    });

    it('thread context is isolated from parent (uses thread chatJid)', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: '9999000000000001',
        channelType: 11, // PublicThread
        parentChannelId: '1234567890123456',
        content: 'Thread-only message',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      // Message must be stored under the thread's own JID, not the parent's
      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:9999000000000001',
        expect.objectContaining({ chat_jid: 'dc:9999000000000001' }),
      );
      // Must NOT be stored under parent JID
      expect(opts.onMessage).not.toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.anything(),
      );
    });

    it('registers thread JID ephemerally so host message loop can query it', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: '9999000000000001',
        channelType: 11, // PublicThread
        parentChannelId: '1234567890123456',
        content: 'Thread message',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      // Must call registerEphemeralGroup with the thread JID so index.ts includes it
      // in getNewMessages queries and processGroupMessages can find the group
      expect(opts.registerEphemeralGroup).toHaveBeenCalledWith(
        'dc:9999000000000001',
        expect.objectContaining({ folder: 'test-server' }),
      );
    });

    it('does not re-register thread JID if already in registeredGroups', async () => {
      // Simulate second message in thread — JID already registered
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:1234567890123456': {
            name: 'Test Server #general',
            folder: 'test-server',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
          'dc:9999000000000001': {
            name: 'Test Server #thread',
            folder: 'test-server',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: '9999000000000001',
        channelType: 11,
        parentChannelId: '1234567890123456',
        content: 'Second thread message',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.registerEphemeralGroup).not.toHaveBeenCalled();
    });

    it('ignores thread message when parent channel is also unregistered', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: '9999000000000099', // unregistered thread
        channelType: 11, // PublicThread
        parentChannelId: '8888000000000000', // unregistered parent
        content: 'No match',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('supports PrivateThread type', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: '9999000000000002',
        channelType: 12, // PrivateThread
        parentChannelId: '1234567890123456',
        content: 'Private thread',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:9999000000000002',
        expect.objectContaining({ content: 'Private thread' }),
      );
    });

    it('supports AnnouncementThread type', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: '9999000000000003',
        channelType: 10, // AnnouncementThread
        parentChannelId: '1234567890123456',
        content: 'Announcement thread',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:9999000000000003',
        expect.objectContaining({ content: 'Announcement thread' }),
      );
    });
  });

  // --- Thread auto-join ---

  describe('thread auto-join', () => {
    it('joins a new thread when its parent channel is registered', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const joinFn = vi.fn().mockResolvedValue(undefined);
      const thread = {
        id: '9999000000000001',
        parentId: '1234567890123456', // registered parent
        name: 'my-thread',
        join: joinFn,
      };

      const handlers = currentClient().eventHandlers.get('threadCreate') || [];
      for (const h of handlers) await h(thread);

      expect(joinFn).toHaveBeenCalled();
    });

    it('does not join a thread whose parent is unregistered', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const joinFn = vi.fn().mockResolvedValue(undefined);
      const thread = {
        id: '9999000000000099',
        parentId: '8888000000000000', // NOT registered
        name: 'other-thread',
        join: joinFn,
      };

      const handlers = currentClient().eventHandlers.get('threadCreate') || [];
      for (const h of handlers) await h(thread);

      expect(joinFn).not.toHaveBeenCalled();
    });

    it('does not join a thread with no parentId', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const joinFn = vi.fn().mockResolvedValue(undefined);
      const thread = { id: '9999000000000001', parentId: null, name: 'orphan', join: joinFn };

      const handlers = currentClient().eventHandlers.get('threadCreate') || [];
      for (const h of handlers) await h(thread);

      expect(joinFn).not.toHaveBeenCalled();
    });
  });

  // --- Thread cleanup ---

  describe('thread cleanup', () => {
    function registeredWithThread() {
      const groups: Record<string, any> = {
        'dc:1234567890123456': { name: 'Test Server #general', folder: 'test-server', trigger: '@Andy', added_at: '' },
        'dc:9999000000000001': { name: 'Test Thread', folder: 'test-server', trigger: '@Andy', added_at: '' },
      };
      return vi.fn(() => groups);
    }

    it('unregisters thread JID when thread is deleted', async () => {
      const opts = createTestOpts({ registeredGroups: registeredWithThread() });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const handlers = currentClient().eventHandlers.get('threadDelete') || [];
      for (const h of handlers) await h({ id: '9999000000000001' });

      expect(opts.unregisterEphemeralGroup).toHaveBeenCalledWith('dc:9999000000000001');
    });

    it('does not unregister a thread JID that was never registered', async () => {
      const opts = createTestOpts(); // only has parent channel
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const handlers = currentClient().eventHandlers.get('threadDelete') || [];
      for (const h of handlers) await h({ id: '9999000000000001' });

      expect(opts.unregisterEphemeralGroup).not.toHaveBeenCalled();
    });

    it('unregisters thread JID when thread is archived', async () => {
      const opts = createTestOpts({ registeredGroups: registeredWithThread() });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const handlers = currentClient().eventHandlers.get('threadUpdate') || [];
      for (const h of handlers) await h(
        { id: '9999000000000001', archived: false },
        { id: '9999000000000001', archived: true },
      );

      expect(opts.unregisterEphemeralGroup).toHaveBeenCalledWith('dc:9999000000000001');
    });

    it('does not unregister thread when updated but not archived', async () => {
      const opts = createTestOpts({ registeredGroups: registeredWithThread() });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const handlers = currentClient().eventHandlers.get('threadUpdate') || [];
      for (const h of handlers) await h(
        { id: '9999000000000001', archived: false },
        { id: '9999000000000001', archived: false, name: 'Renamed Thread' },
      );

      expect(opts.unregisterEphemeralGroup).not.toHaveBeenCalled();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "discord"', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.name).toBe('discord');
    });
  });
});
