import { AnyThreadChannel, ChannelType, Client, Events, GatewayIntentBits, Message, TextChannel, ThreadChannel } from 'discord.js';

import { ASSISTANT_NAME, DISCORD_BOT_TOKEN, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcription.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';


export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: ChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: ChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      // Ignore system messages (thread creation, pins, boosts, etc.)
      // Only process regular messages (type 0) and replies (type 19)
      if (message.type !== 0 && message.type !== 19) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — transcribe audio, store placeholders for others
      if (message.attachments.size > 0) {
        const attachmentPromises = [...message.attachments.values()].map(async (att) => {
          const contentType = att.contentType || '';
          if (contentType.startsWith('image/')) {
            return `[Image: ${att.name || 'image'}]`;
          } else if (contentType.startsWith('video/')) {
            return `[Video: ${att.name || 'video'}]`;
          } else if (contentType.startsWith('audio/')) {
            const text = await transcribeAudio(att.url);
            if (text) return `[Voice: ${text}]`;
            return `[Audio: ${att.name || 'audio'}]`;
          } else {
            return `[File: ${att.name || 'file'}]`;
          }
        });
        const attachmentDescriptions = await Promise.all(attachmentPromises);
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Resolve the effective group: direct match, or parent channel for threads.
      // Threads inherit the parent channel's registration — each thread gets its own
      // chatJid so context is naturally isolated per thread.
      const isThread =
        message.channel.type === ChannelType.PublicThread ||
        message.channel.type === ChannelType.PrivateThread ||
        message.channel.type === ChannelType.AnnouncementThread;

      const parentJid = isThread
        ? `dc:${(message.channel as ThreadChannel).parentId}`
        : null;

      const group =
        this.opts.registeredGroups()[chatJid] ??
        (parentJid ? this.opts.registeredGroups()[parentJid] : null);

      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // For thread JIDs that resolved via the parent, register the thread
      // ephemerally in the host so the message loop queries it.
      // Without this, index.ts only queries Object.keys(registeredGroups)
      // which never includes thread JIDs, so messages are stored but never processed.
      if (isThread && !this.opts.registeredGroups()[chatJid]) {
        this.opts.registerEphemeralGroup?.(chatJid, group);
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Auto-join threads created in registered channels so the bot receives messages in them.
    // Discord bots are not automatically members of new threads — without joining, MessageCreate
    // events from the thread are never delivered.
    this.client.on(Events.ThreadCreate, async (thread: AnyThreadChannel) => {
      if (!thread.parentId) return;
      const parentJid = `dc:${thread.parentId}`;
      if (!this.opts.registeredGroups()[parentJid]) return;
      try {
        await thread.join();
        logger.info(
          { threadId: thread.id, parentId: thread.parentId, name: thread.name },
          'Auto-joined thread in registered channel',
        );
      } catch (err) {
        logger.warn({ err, threadId: thread.id }, 'Failed to auto-join thread');
      }
    });

    // Remove ephemeral thread registrations when threads are deleted or archived.
    this.client.on(Events.ThreadDelete, (thread: AnyThreadChannel) => {
      const jid = `dc:${thread.id}`;
      if (this.opts.registeredGroups()[jid]) {
        this.opts.unregisterEphemeralGroup?.(jid);
        logger.info({ threadId: thread.id }, 'Unregistered deleted thread');
      }
    });

    this.client.on(Events.ThreadUpdate, (_oldThread: AnyThreadChannel, newThread: AnyThreadChannel) => {
      if (!newThread.archived) return;
      const jid = `dc:${newThread.id}`;
      if (this.opts.registeredGroups()[jid]) {
        this.opts.unregisterEphemeralGroup?.(jid);
        logger.info({ threadId: newThread.id }, 'Unregistered archived thread');
      }
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, async (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );

        // Join any active threads that already exist in registered channels.
        // Handles threads created before this bot session started.
        await this.joinExistingThreads(readyClient);

        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  private async joinExistingThreads(readyClient: Client): Promise<void> {
    const registeredJids = new Set(Object.keys(this.opts.registeredGroups()));
    let joined = 0;

    for (const guild of readyClient.guilds.cache.values()) {
      try {
        const channels = await guild.channels.fetch();
        for (const channel of channels.values()) {
          if (!channel || !registeredJids.has(`dc:${channel.id}`)) continue;
          if (!('threads' in channel)) continue;

          const textChannel = channel as TextChannel;
          const activeThreads = await textChannel.threads.fetchActive();
          for (const thread of activeThreads.threads.values()) {
            try {
              await thread.join();
              joined++;
            } catch {
              // Thread may already be joined or archived
            }
          }
        }
      } catch (err) {
        logger.warn({ err, guildId: guild.id }, 'Failed to fetch channels for thread join');
      }
    }

    if (joined > 0) {
      logger.info({ joined }, 'Joined existing active threads in registered channels');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  if (!DISCORD_BOT_TOKEN) return null;
  return new DiscordChannel(DISCORD_BOT_TOKEN, opts);
});
