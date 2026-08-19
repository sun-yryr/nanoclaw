import { Readable } from 'stream';

import { Client, GatewayIntentBits, type Guild, type Message, type VoiceBasedChannel } from 'discord.js';
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import prism from 'prism-media';

import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { routeInbound } from '../../router.js';
import { onShutdown } from '../../response-registry.js';
import { decideVoiceResponse } from './decision.js';
import {
  judgeVoiceResponseWithOpenAI,
  synthesizeWithOpenAI,
  transcribeWithOpenAI,
  type OpenAIAudioConfig,
} from './openai.js';

interface DiscordVoiceConfig {
  enabled: boolean;
  botToken: string;
  commandPrefix: string;
  responseProbability: number;
  aiJudge: boolean;
  routeUnanswered: boolean;
  postTranscripts: boolean;
  silenceMs: number;
  minAudioMs: number;
  pendingReplyTtlMs: number;
  openai: OpenAIAudioConfig;
}

/** Marks bot-posted STT lines so speakPendingReply ignores them. */
const VOICE_TRANSCRIPT_MARKER = '\uFEFF';

interface VoiceSession {
  guildId: string;
  textChannelId: string;
  voiceChannelId: string;
  platformId: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  capturing: Set<string>;
}

interface PendingVoiceReply {
  guildId: string;
  textChannelId: string;
  expiresAt: number;
}

let activeController: DiscordVoiceController | null = null;

export async function startDiscordVoice(): Promise<void> {
  if (activeController) return;

  const config = loadConfig();
  if (!config.enabled) {
    log.debug('[discord-voice] disabled');
    return;
  }
  if (!config.botToken) {
    log.warn('[discord-voice] disabled because DISCORD_BOT_TOKEN is missing');
    return;
  }
  if (!config.openai.apiKey) {
    log.warn('[discord-voice] disabled because OPENAI_API_KEY is missing');
    return;
  }

  const controller = new DiscordVoiceController(config);
  activeController = controller;
  onShutdown(() => controller.stop());
  await controller.start();
}

class DiscordVoiceController {
  private readonly client: Client;
  private readonly sessions = new Map<string, VoiceSession>();
  private readonly pendingReplies = new Map<string, PendingVoiceReply>();
  private readonly playQueues = new Map<string, Promise<void>>();

  constructor(private readonly config: DiscordVoiceConfig) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  async start(): Promise<void> {
    this.client.on('messageCreate', (message) => {
      void this.handleMessage(message).catch((err) => log.warn('[discord-voice] message handler failed', { err }));
    });
    this.client.once('ready', () => {
      log.info('[discord-voice] ready', { user: this.client.user?.tag, prefix: this.config.commandPrefix });
    });
    await this.client.login(this.config.botToken);
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.connection.destroy();
    }
    this.sessions.clear();
    this.pendingReplies.clear();
    await this.client.destroy();
    activeController = null;
  }

  private async handleMessage(message: Message): Promise<void> {
    if (!message.guild) return;

    if (message.author.id === this.client.user?.id) {
      if (!isVoiceTranscriptChannelMessage(message.content)) {
        await this.speakPendingReply(message);
      }
      return;
    }

    if (message.author.bot) return;
    const content = message.content.trim();
    if (!content.startsWith(this.config.commandPrefix)) return;

    const command = content.slice(this.config.commandPrefix.length).trim().split(/\s+/)[0]?.toLowerCase();
    if (command === 'join') {
      await this.handleJoinCommand(message);
    } else if (command === 'leave') {
      await this.handleLeaveCommand(message);
    } else if (command === 'status') {
      await this.handleStatusCommand(message);
    } else {
      await message.reply(`Usage: \`${this.config.commandPrefix} join|leave|status\``);
    }
  }

  private async handleJoinCommand(message: Message): Promise<void> {
    const voiceChannel = message.member?.voice.channel;
    if (!voiceChannel) {
      await message.reply('Join a voice channel first, then run the join command again.');
      return;
    }

    const session = await this.join(message.guild!, voiceChannel, message.channelId);
    await message.reply(`Joined **${voiceChannel.name}** and linked voice replies to this text channel.`);
    log.info('[discord-voice] joined voice channel', {
      guildId: session.guildId,
      voiceChannelId: session.voiceChannelId,
      textChannelId: session.textChannelId,
    });
  }

  private async handleLeaveCommand(message: Message): Promise<void> {
    const key = message.guild!.id;
    const session = this.sessions.get(key);
    if (!session) {
      await message.reply('I am not connected to a voice channel in this server.');
      return;
    }

    session.connection.destroy();
    this.sessions.delete(key);
    this.pendingReplies.delete(replyKey(session.guildId, session.textChannelId));
    await message.reply('Disconnected from the voice channel.');
  }

  private async handleStatusCommand(message: Message): Promise<void> {
    const session = this.sessions.get(message.guild!.id);
    if (!session) {
      await message.reply('Discord voice is enabled, but I am not connected in this server.');
      return;
    }
    await message.reply(
      `Connected to <#${session.voiceChannelId}>. Voice replies are linked to <#${session.textChannelId}>.`,
    );
  }

  private async join(guild: Guild, voiceChannel: VoiceBasedChannel, textChannelId: string): Promise<VoiceSession> {
    const existing = this.sessions.get(guild.id);
    if (existing) {
      existing.connection.destroy();
      this.sessions.delete(guild.id);
    }

    const connection = joinVoiceChannel({
      guildId: guild.id,
      channelId: voiceChannel.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });
    connection.subscribe(player);

    const session: VoiceSession = {
      guildId: guild.id,
      textChannelId,
      voiceChannelId: voiceChannel.id,
      platformId: `discord:${guild.id}:${textChannelId}`,
      connection,
      player,
      capturing: new Set(),
    };

    connection.receiver.speaking.on('start', (userId) => {
      void this.captureUserSpeech(session, userId).catch((err) =>
        log.warn('[discord-voice] speech capture failed', { guildId: session.guildId, userId, err }),
      );
    });

    this.sessions.set(guild.id, session);
    return session;
  }

  private async captureUserSpeech(session: VoiceSession, userId: string): Promise<void> {
    if (userId === this.client.user?.id || session.capturing.has(userId)) return;
    session.capturing.add(userId);

    try {
      const opusStream = session.connection.receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: this.config.silenceMs,
        },
      });
      const decoder = new prism.opus.Decoder({
        rate: 48_000,
        channels: 2,
        frameSize: 960,
      });

      const chunks: Buffer[] = [];
      opusStream.pipe(decoder);
      for await (const chunk of decoder as AsyncIterable<Buffer>) {
        chunks.push(Buffer.from(chunk));
      }

      const pcm = Buffer.concat(chunks);
      const minBytes = Math.floor((48_000 * 2 * 2 * this.config.minAudioMs) / 1000);
      if (pcm.length < minBytes) return;

      const speaker = await this.client.users.fetch(userId).catch(() => null);
      const speakerName = speaker?.globalName ?? speaker?.username ?? userId;
      const transcript = await transcribeWithOpenAI(pcm16leToWav(pcm, 48_000, 2), this.config.openai);
      if (!transcript) return;

      const decision = await decideVoiceResponse({
        transcript,
        speakerName,
        probability: this.config.responseProbability,
        botNames: [this.client.user?.username ?? '', 'NanoClaw'],
        aiJudge: this.config.aiJudge
          ? (input) => judgeVoiceResponseWithOpenAI(input.transcript, this.config.openai, input.speakerName)
          : undefined,
      });

      log.info('[discord-voice] transcribed speech', {
        guildId: session.guildId,
        speaker: speakerName,
        respond: decision.respond,
        reason: decision.reason,
      });

      if (this.config.postTranscripts) {
        await this.postTranscriptToChannel(session, speakerName, transcript).catch((err) =>
          log.warn('[discord-voice] failed to post transcript', { guildId: session.guildId, err }),
        );
      }

      if (!decision.respond && !this.config.routeUnanswered) return;
      if (decision.respond) {
        this.pendingReplies.set(replyKey(session.guildId, session.textChannelId), {
          guildId: session.guildId,
          textChannelId: session.textChannelId,
          expiresAt: Date.now() + this.config.pendingReplyTtlMs,
        });
      }

      await routeInbound({
        channelType: 'discord',
        instance: 'discord',
        platformId: session.platformId,
        threadId: null,
        message: {
          id: `discord-voice-${Date.now()}-${userId}`,
          kind: 'chat-sdk',
          content: JSON.stringify({
            text: `[Voice transcript] ${transcript}`,
            interactionMode: 'voice',
            sender: speakerName,
            senderId: userId,
            author: {
              userId,
              userName: speaker?.username ?? speakerName,
              fullName: speakerName,
            },
          }),
          timestamp: new Date().toISOString(),
          isMention: decision.respond,
          isGroup: true,
        },
      });
    } finally {
      session.capturing.delete(userId);
    }
  }

  private async postTranscriptToChannel(session: VoiceSession, speakerName: string, transcript: string): Promise<void> {
    const channel = await this.client.channels.fetch(session.textChannelId);
    if (!channel?.isTextBased() || !('send' in channel) || typeof channel.send !== 'function') {
      throw new Error(`text channel ${session.textChannelId} is not sendable`);
    }

    await channel.send(formatTranscriptChannelMessage(speakerName, transcript));
  }

  private async speakPendingReply(message: Message): Promise<void> {
    const key = replyKey(message.guild!.id, message.channelId);
    const pending = this.pendingReplies.get(key);
    if (!pending || pending.expiresAt < Date.now()) {
      this.pendingReplies.delete(key);
      return;
    }

    const session = this.sessions.get(pending.guildId);
    if (!session || session.textChannelId !== pending.textChannelId) return;

    this.pendingReplies.delete(key);
    const speechText = cleanForSpeech(message.content);
    if (!speechText) return;

    const audio = await synthesizeWithOpenAI(speechText, this.config.openai);
    await this.enqueuePlayback(session, audio);
  }

  private async enqueuePlayback(session: VoiceSession, audioWav: Buffer): Promise<void> {
    const prior = this.playQueues.get(session.guildId) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(() => this.playAudio(session, audioWav))
      .finally(() => {
        if (this.playQueues.get(session.guildId) === next) {
          this.playQueues.delete(session.guildId);
        }
      });
    this.playQueues.set(session.guildId, next);
    await next;
  }

  private async playAudio(session: VoiceSession, audioWav: Buffer): Promise<void> {
    const resource = createAudioResource(Readable.from(audioWav), { inputType: StreamType.Arbitrary });
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        session.player.off(AudioPlayerStatus.Idle, onIdle);
        session.player.off('error', onError);
      };
      const onIdle = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      session.player.once(AudioPlayerStatus.Idle, onIdle);
      session.player.once('error', onError);
      session.player.play(resource);
    });
  }
}

function loadConfig(): DiscordVoiceConfig {
  const fileEnv = readEnvFile([
    'DISCORD_BOT_TOKEN',
    'DISCORD_VOICE_ENABLED',
    'DISCORD_VOICE_COMMAND_PREFIX',
    'DISCORD_VOICE_RESPONSE_PROBABILITY',
    'DISCORD_VOICE_AI_JUDGE',
    'DISCORD_VOICE_ROUTE_UNANSWERED',
    'DISCORD_VOICE_POST_TRANSCRIPTS',
    'DISCORD_VOICE_SILENCE_MS',
    'DISCORD_VOICE_MIN_AUDIO_MS',
    'DISCORD_VOICE_PENDING_REPLY_TTL_MS',
    'DISCORD_VOICE_OPENAI_BASE_URL',
    'DISCORD_VOICE_STT_MODEL',
    'DISCORD_VOICE_TTS_MODEL',
    'DISCORD_VOICE_TTS_VOICE',
    'DISCORD_VOICE_JUDGE_MODEL',
    'OPENAI_API_KEY',
  ]);
  const get = (key: string, fallback = '') => process.env[key] ?? fileEnv[key] ?? fallback;

  return {
    enabled: parseBoolean(get('DISCORD_VOICE_ENABLED'), false),
    botToken: get('DISCORD_BOT_TOKEN'),
    commandPrefix: get('DISCORD_VOICE_COMMAND_PREFIX', '!nc voice'),
    responseProbability: parseProbability(get('DISCORD_VOICE_RESPONSE_PROBABILITY', '0.15')),
    aiJudge: parseBoolean(get('DISCORD_VOICE_AI_JUDGE'), false),
    routeUnanswered: parseBoolean(get('DISCORD_VOICE_ROUTE_UNANSWERED'), false),
    postTranscripts: parseBoolean(get('DISCORD_VOICE_POST_TRANSCRIPTS'), false),
    silenceMs: parsePositiveInt(get('DISCORD_VOICE_SILENCE_MS'), 900),
    minAudioMs: parsePositiveInt(get('DISCORD_VOICE_MIN_AUDIO_MS'), 700),
    pendingReplyTtlMs: parsePositiveInt(get('DISCORD_VOICE_PENDING_REPLY_TTL_MS'), 120_000),
    openai: {
      apiKey: get('OPENAI_API_KEY'),
      baseUrl: get('DISCORD_VOICE_OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
      sttModel: get('DISCORD_VOICE_STT_MODEL', 'gpt-4o-mini-transcribe'),
      ttsModel: get('DISCORD_VOICE_TTS_MODEL', 'gpt-4o-mini-tts'),
      ttsVoice: get('DISCORD_VOICE_TTS_VOICE', 'alloy'),
      judgeModel: get('DISCORD_VOICE_JUDGE_MODEL', 'gpt-4o-mini'),
    },
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseProbability(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 0.15;
  return Math.max(0, Math.min(1, parsed));
}

function replyKey(guildId: string, textChannelId: string): string {
  return `${guildId}:${textChannelId}`;
}

export function formatTranscriptChannelMessage(speakerName: string, transcript: string): string {
  return `${VOICE_TRANSCRIPT_MARKER}🎤 **${speakerName}**: ${transcript}`;
}

export function isVoiceTranscriptChannelMessage(content: string): boolean {
  return content.startsWith(VOICE_TRANSCRIPT_MARKER);
}

function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' code block omitted ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<@!?(\d+)>/g, ' someone ')
    .replace(/<#[0-9]+>/g, ' this channel ')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

function pcm16leToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}
