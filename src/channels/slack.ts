// @slack/bolt ships as CommonJS, so named ESM imports fail at runtime.
// Use the default import and destructure.
import bolt from '@slack/bolt';
import type { App as AppType } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
const { App, LogLevel } = bolt;

import {
  ASSISTANT_NAME,
  SLACK_APP_TOKEN,
  SLACK_BOT_TOKEN,
  TRIGGER_PATTERN,
} from '../config.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcription.js';
import { Channel } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const SLACK_PREFIX = 'sl:';

// JID format:
//   sl:<channelId>                    — top-level message in channel/DM
//   sl:<channelId>:<thread_ts>        — message in a thread
// Threads inherit the parent channel's registration (mirrors Discord behavior);
// each thread gets its own JID so per-thread context is isolated.
function parseJid(jid: string): { channelId: string; threadTs?: string } | null {
  if (!jid.startsWith(SLACK_PREFIX)) return null;
  const rest = jid.slice(SLACK_PREFIX.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) return { channelId: rest };
  return {
    channelId: rest.slice(0, colonIdx),
    threadTs: rest.slice(colonIdx + 1),
  };
}

function buildJid(channelId: string, threadTs?: string): string {
  return threadTs
    ? `${SLACK_PREFIX}${channelId}:${threadTs}`
    : `${SLACK_PREFIX}${channelId}`;
}


export class SlackChannel implements Channel {
  name = 'slack';

  private app: AppType | null = null;
  private client: WebClient | null = null;
  private botUserId: string | null = null;
  private opts: ChannelOpts;
  private botToken: string;
  private appToken: string;
  private userNameCache = new Map<string, string>();
  private channelNameCache = new Map<string, string>();

  constructor(botToken: string, appToken: string, opts: ChannelOpts) {
    this.botToken = botToken;
    this.appToken = appToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });
    this.client = this.app.client;

    this.app.message(async ({ message }) => {
      // The `message` event has many subtypes — bot messages, edits, deletions,
      // joins, channel renames, etc. Only handle plain user messages.
      // Plain user messages have `subtype` undefined; thread broadcasts ("Also
      // send to channel") have subtype "thread_broadcast" but we treat those
      // as normal too.
      const subtype = (message as { subtype?: string }).subtype;
      if (subtype && subtype !== 'thread_broadcast') return;

      const msg = message as {
        ts: string;
        text?: string;
        user?: string;
        bot_id?: string;
        channel: string;
        thread_ts?: string;
        channel_type?: string;
        files?: Array<{
          id: string;
          name?: string;
          mimetype?: string;
          url_private?: string;
          url_private_download?: string;
        }>;
      };

      // Ignore bot messages (including own)
      if (msg.bot_id || !msg.user) return;
      if (this.botUserId && msg.user === this.botUserId) return;

      const channelId = msg.channel;
      // Top-level messages have thread_ts === ts (or undefined). Replies have
      // a different thread_ts pointing at the parent.
      const isThreadReply = !!msg.thread_ts && msg.thread_ts !== msg.ts;
      const chatJid = isThreadReply
        ? buildJid(channelId, msg.thread_ts)
        : buildJid(channelId);
      const parentJid = buildJid(channelId);

      const timestamp = slackTsToIso(msg.ts);
      const senderName = await this.resolveUserName(msg.user);
      let content = msg.text || '';

      // Resolve channel name for chat metadata
      const channelName = await this.resolveChannelName(channelId);
      const chatName = isThreadReply
        ? `${channelName} (thread)`
        : channelName;

      // Translate Slack <@U123> mentions of the bot into TRIGGER_PATTERN format.
      // Without this, mentions wouldn't match TRIGGER_PATTERN (e.g. ^@Andy\b).
      if (this.botUserId) {
        const mentionPattern = new RegExp(`<@${this.botUserId}>`, 'g');
        const isBotMentioned = mentionPattern.test(content);
        if (isBotMentioned) {
          content = content.replace(mentionPattern, '').trim();
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Expand any remaining user mentions to display names for readability.
      content = await this.expandUserMentions(content);

      // Handle file attachments — transcribe audio, placeholders for others.
      if (msg.files && msg.files.length > 0) {
        const descriptions = await Promise.all(
          msg.files.map(async (f) => {
            const mime = f.mimetype || '';
            const name = f.name || 'file';
            if (mime.startsWith('image/')) return `[Image: ${name}]`;
            if (mime.startsWith('video/')) return `[Video: ${name}]`;
            if (mime.startsWith('audio/')) {
              const downloadUrl = f.url_private_download || f.url_private;
              if (downloadUrl) {
                const text = await transcribeAudio(
                  downloadUrl,
                  `Bearer ${this.botToken}`,
                );
                if (text) return `[Voice: ${text}]`;
              }
              return `[Audio: ${name}]`;
            }
            return `[File: ${name}]`;
          }),
        );
        content = content
          ? `${content}\n${descriptions.join('\n')}`
          : descriptions.join('\n');
      }

      // Store chat metadata for discovery (both parent and thread JID if applicable)
      this.opts.onChatMetadata(parentJid, timestamp, channelName, 'slack', true);
      if (isThreadReply) {
        this.opts.onChatMetadata(chatJid, timestamp, chatName, 'slack', true);
      }

      // Resolve effective group: direct match, or parent channel for threads.
      const group =
        this.opts.registeredGroups()[chatJid] ??
        (isThreadReply ? this.opts.registeredGroups()[parentJid] : null);

      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Slack channel',
        );
        return;
      }

      // For thread JIDs that resolved via the parent, register ephemerally
      // so the host's message loop queries them.
      if (isThreadReply && !this.opts.registeredGroups()[chatJid]) {
        this.opts.registerEphemeralGroup?.(chatJid, group);
      }

      this.opts.onMessage(chatJid, {
        id: msg.ts,
        chat_jid: chatJid,
        sender: msg.user,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Slack message stored',
      );
    });

    this.app.error(async (err) => {
      logger.error({ err: err.message }, 'Slack app error');
    });

    await this.app.start();

    // Fetch the bot's own user id so we can detect mentions and skip our own messages.
    try {
      const authRes = await this.client.auth.test();
      this.botUserId = (authRes.user_id as string) ?? null;
      logger.info(
        { botUserId: this.botUserId, botName: authRes.user, team: authRes.team },
        'Slack bot connected',
      );
      console.log(`\n  Slack bot: ${authRes.user} (team ${authRes.team})`);
      console.log(
        `  Use the channel ID from "View channel details" to register a channel.\n`,
      );
    } catch (err) {
      logger.error({ err }, 'Failed to call auth.test after Slack connect');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Slack client not initialized');
      return;
    }
    const parsed = parseJid(jid);
    if (!parsed) {
      logger.warn({ jid }, 'Invalid Slack JID');
      return;
    }

    try {
      // Slack's hard limit is ~40k chars per message; we chunk at 3500 to stay
      // well within block-kit limits and keep messages readable.
      const MAX_LENGTH = 3500;
      const chunks: string[] = [];
      if (text.length <= MAX_LENGTH) {
        chunks.push(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          chunks.push(text.slice(i, i + MAX_LENGTH));
        }
      }
      for (const chunk of chunks) {
        await this.client.chat.postMessage({
          channel: parsed.channelId,
          text: chunk,
          thread_ts: parsed.threadTs,
        });
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Slack message');
    }
  }

  isConnected(): boolean {
    return this.app !== null && this.botUserId !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(SLACK_PREFIX);
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
      this.client = null;
      logger.info('Slack bot stopped');
    }
  }

  private async resolveUserName(userId: string): Promise<string> {
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;
    if (!this.client) return userId;
    try {
      const res = await this.client.users.info({ user: userId });
      const profile = res.user?.profile;
      const name =
        profile?.display_name?.trim() ||
        profile?.real_name?.trim() ||
        res.user?.name ||
        userId;
      this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ err, userId }, 'Failed to resolve Slack user name');
      return userId;
    }
  }

  private async resolveChannelName(channelId: string): Promise<string> {
    const cached = this.channelNameCache.get(channelId);
    if (cached) return cached;
    if (!this.client) return channelId;
    try {
      const res = await this.client.conversations.info({ channel: channelId });
      const ch = res.channel as
        | { name?: string; is_im?: boolean; user?: string }
        | undefined;
      let name: string;
      if (ch?.is_im && ch.user) {
        name = `DM with ${await this.resolveUserName(ch.user)}`;
      } else {
        name = ch?.name ? `#${ch.name}` : channelId;
      }
      this.channelNameCache.set(channelId, name);
      return name;
    } catch (err) {
      logger.debug({ err, channelId }, 'Failed to resolve Slack channel name');
      return channelId;
    }
  }

  private async expandUserMentions(text: string): Promise<string> {
    const matches = [...text.matchAll(/<@(U[A-Z0-9]+)>/g)];
    if (matches.length === 0) return text;
    let out = text;
    for (const match of matches) {
      const name = await this.resolveUserName(match[1]);
      out = out.replace(match[0], `@${name}`);
    }
    return out;
  }
}

// Slack message timestamps are floating-point seconds since epoch (e.g.
// "1700000000.123456"). Convert to ISO so it sorts correctly alongside the
// timestamps from other channels.
function slackTsToIso(ts: string): string {
  const seconds = parseFloat(ts);
  if (!isFinite(seconds)) return new Date().toISOString();
  return new Date(seconds * 1000).toISOString();
}

registerChannel('slack', (opts: ChannelOpts) => {
  if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) return null;
  return new SlackChannel(SLACK_BOT_TOKEN, SLACK_APP_TOKEN, opts);
});
