import 'dotenv/config';
import crypto from 'node:crypto';
import { Client, Collection, GatewayIntentBits } from 'discord.js';
import { REST } from '@discordjs/rest';
import express from 'express';
import cron from 'node-cron';

import config from './config/application.js';
import { initializeDatabase } from './utils/database.js';
import { getGuildConfig } from './services/config/guildConfig.js';
import { getServerCounters, saveServerCounters, updateCounter } from './services/serverstatsService.js';
import { logger, startupLog, shutdownLog } from './utils/logger.js';
import { checkBirthdays } from './services/birthdayService.js';
import { checkGiveaways } from './services/giveawayService.js';
import { loadCommands, registerCommands as registerSlashCommands } from './handlers/loaders/commandLoader.js';
import { runSafeTask, handleTaskError, ErrorCodes } from './utils/errorHandler.js';
import { initializeMusic } from './services/music/riffySetup.js';
import { shutdownMusic } from './services/music/playerHandler.js';
import pkg from '../package.json' with { type: 'json' };
import { EXPECTED_SCHEMA_VERSION, EXPECTED_SCHEMA_LABEL } from './config/database/schemaVersion.js';

class TitanBot extends Client {
  constructor() {
    super({
      intents: [
        
        GatewayIntentBits.Guilds,                        
        GatewayIntentBits.GuildMembers,                 

        GatewayIntentBits.GuildMessages,                
        GatewayIntentBits.GuildMessageReactions,        
        GatewayIntentBits.MessageContent,               
        GatewayIntentBits.DirectMessages,

        GatewayIntentBits.GuildVoiceStates,             

        GatewayIntentBits.GuildBans,                    
      ],
    });

    this.config = config;
    this.commands = new Collection();
    this.events = new Collection();
    this.buttons = new Collection();
    this.selectMenus = new Collection();
    this.modals = new Collection();
    this.cooldowns = new Collection();
    this.db = null;
    this.rest = new REST({ version: '10' }).setToken(config.bot.token);
  }

  async start() {
    try {
      startupLog('Starting TitanBot...');
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      startupLog('Initializing database...');
      const dbInstance = await initializeDatabase();
      this.db = dbInstance.db;

      // Check database status and report
      const dbStatus = this.db.getStatus();
      if (dbStatus.isDegraded) {
        logger.warn('');
        logger.warn('╔═══════════════════════════════════════════════════════╗');
        logger.warn('║ ⚠️  DATABASE RUNNING IN DEGRADED MODE                 ║');
        logger.warn('║                                                       ║');
        logger.warn('║ Connection: In-Memory Storage (PostgreSQL unavailable)║');
        logger.warn('║ Data Persistence: DISABLED - data lost on restart    ║');
        logger.warn('║ Action Required: Fix PostgreSQL and restart bot      ║');
        logger.warn('╚═══════════════════════════════════════════════════════╝');
        logger.warn('');
      } else {
        startupLog(`✅ Database Status: ${dbStatus.connectionType} (fully operational)`);
      }
      
      startupLog('Starting web server...');
      this.startWebServer();
      
      startupLog('Loading commands...');
      await loadCommands(this);
      startupLog(`Commands loaded: ${this.commands.size}`);
      
      startupLog('Loading handlers...');
      await this.loadHandlers();
      startupLog('Handlers loaded');

      initializeMusic(this);
      
      startupLog('Logging into Discord...');
      await this.login(this.config.bot.token);
      startupLog('Discord login successful');
      
      startupLog('Registering slash commands globally...');
      await this.registerCommands();
      startupLog('Slash commands registration complete');
      
      const databaseMode = dbStatus.isDegraded
        ? 'Optional in-memory mode (data resets after restart)'
        : 'Connected (persistent data enabled)';
      const handlerSummary = `${this.buttons.size} buttons, ${this.selectMenus.size} menus, ${this.modals.size} modals`;
      startupLog(
        `ONLINE ✅ | ${this.commands.size} commands loaded | ${handlerSummary} | Database: ${databaseMode}`
      );
      
      this.setupCronJobs();
    } catch (error) {
      logger.error('Failed to start bot:', error);
      process.exit(1);
    }
  }

  startWebServer() {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '32kb' }));
    const configuredPort = Number(this.config.api?.port || process.env.PORT || 3000);
    const maxPortRetryAttempts = Number(process.env.PORT_RETRY_ATTEMPTS || 5);
    const host = process.env.WEB_HOST || '0.0.0.0';
    const corsOrigin = this.config.api?.cors?.origin || '*';
    
    app.use((req, res, next) => {
      const allowedOrigins = Array.isArray(corsOrigin) ? corsOrigin : [corsOrigin];
      const origin = req.headers.origin;
      
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin || '*');
      }
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    });

    const requestCounts = new Map();
    const windowMs = this.config.api?.rateLimit?.windowMs || 60000;
    const maxRequests = this.config.api?.rateLimit?.max || 100;
    
    app.use((req, res, next) => {
      if (
        req.path === '/health' ||
        req.path === '/ready' ||
        req.path === '/chat/stream' ||
        req.path === '/chat/history' ||
        req.path.startsWith('/auth/discord/')
      ) {
        return next();
      }
      const ip = req.ip;
      const now = Date.now();
      const windowStart = now - windowMs;
      
      if (!requestCounts.has(ip)) {
        requestCounts.set(ip, []);
      }
      
      const times = requestCounts.get(ip).filter(t => t > windowStart);
      
      if (times.length >= maxRequests) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      
      times.push(now);
      requestCounts.set(ip, times);
      next();
    });

    app.get('/health', (req, res) => {
      const dbStatus = this.db?.getStatus?.() || { isDegraded: 'unknown' };
      const status = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: {
          connected: dbStatus.connectionType !== 'none',
          degraded: dbStatus.isDegraded,
          type: dbStatus.connectionType
        }
      };
      res.status(200).json(status);
    });

    app.get('/ready', (req, res) => {
      const dbStatus = this.db?.getStatus?.() || { isDegraded: true, connectionType: 'none' };
      const isReady = this.isReady() && !dbStatus.isDegraded;

      const metrics = {
        guildCount: this.guilds?.cache?.size ?? 0,
        commandCount: this.commands?.size ?? 0,
        database: {
          mode: dbStatus.connectionType,
          degraded: dbStatus.isDegraded,
          degradedReason: dbStatus.degradedReason ?? null,
        },
        schemaVersion: EXPECTED_SCHEMA_VERSION,
        schemaLabel: EXPECTED_SCHEMA_LABEL,
      };

      if (isReady) {
        return res.status(200).json({
          ready: true,
          message: 'Bot is ready',
          metrics,
        });
      }

      res.status(503).json({
        ready: false,
        reason: !this.isReady() ? 'Bot not Ready' : 'Database degraded',
        metrics,
      });
    });

    app.get('/', (req, res) => {
      res.status(200).json({ 
        message: 'TitanBot System Online',
        version: pkg.version,
        timestamp: new Date().toISOString()
      });
    });

    // Yorumi Global Chat Bridge (Discord Channel <-> Yorumi App)
    const globalChatChannelId = (process.env.GLOBAL_CHAT_CHANNEL_ID || '').trim();
    const globalChatWebhookUrl = (process.env.GLOBAL_CHAT_WEBHOOK_URL || '').trim();
    const discordClientId = (process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID || '').trim();
    const discordClientSecret = (process.env.DISCORD_CLIENT_SECRET || '').trim();
    const publicBaseUrl = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://yorumibot-1.onrender.com').trim().replace(/\/+$/, '');
    const tokenSecret = discordClientSecret || process.env.DISCORD_TOKEN || 'yorumi-chat-secret';
    const pendingAuthSessions = new Map();
    const sseClients = new Set();
    const recentNowWatchingByContent = new Map();

    const signChatToken = (payloadObj) => {
      const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
      const sig = crypto.createHmac('sha256', tokenSecret).update(payload).digest('base64url');
      return `${payload}.${sig}`;
    };

    const verifyChatToken = (token) => {
      try {
        if (!token || typeof token !== 'string' || !token.includes('.')) return null;
        const [payload, sig] = token.split('.');
        const expected = crypto.createHmac('sha256', tokenSecret).update(payload).digest('base64url');
        if (sig !== expected) return null;
        return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
    };

    app.get('/auth/discord/login', (req, res) => {
      const state = String(req.query.state || '').trim();
      if (!discordClientId || !discordClientSecret) {
        return res.status(503).send('Discord OAuth2 is not configured (set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET on Render).');
      }
      if (!state || state.length < 8 || state.length > 128) {
        return res.status(400).send('Invalid auth state');
      }
      const redirectUri = `${publicBaseUrl}/auth/discord/callback`;
      const params = new URLSearchParams({
        client_id: discordClientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'identify',
        state,
      });
      return res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
    });

    app.get('/auth/discord/callback', async (req, res) => {
      const code = String(req.query.code || '').trim();
      const state = String(req.query.state || '').trim();
      if (!code || !state) {
        return res.status(400).send('Missing code or state');
      }
      if (!discordClientId || !discordClientSecret) {
        return res.status(503).send('Discord OAuth2 not configured');
      }
      try {
        const redirectUri = `${publicBaseUrl}/auth/discord/callback`;
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: discordClientId,
            client_secret: discordClientSecret,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
          }),
        });
        if (!tokenRes.ok) {
          const errText = await tokenRes.text().catch(() => '');
          logger.warn(`[GlobalChat OAuth] Token exchange failed (${tokenRes.status}): ${errText}`);
          return res.status(502).send('Discord login failed. Please close this tab and try again.');
        }
        const tokenJson = await tokenRes.json();
        const userRes = await fetch('https://discord.com/api/users/@me', {
          headers: { Authorization: `Bearer ${tokenJson.access_token}` },
        });
        if (!userRes.ok) {
          return res.status(502).send('Could not fetch Discord profile. Please try again.');
        }
        const discordUser = await userRes.json();
        const avatarUrl = discordUser.avatar
          ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=128`
          : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(discordUser.id) >> 22n) % 6}.png`;
        const user = {
          id: String(discordUser.id),
          username: String(discordUser.global_name || discordUser.username || 'Discord User').slice(0, 32),
          handle: String(discordUser.username || ''),
          avatar: avatarUrl,
        };
        const token = signChatToken(user);
        pendingAuthSessions.set(state, { token, user, createdAt: Date.now() });
        setTimeout(() => pendingAuthSessions.delete(state), 5 * 60 * 1000);

        return res.status(200).send(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Yorumi — Signed in</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0b0f;color:#fff;font-family:system-ui,-apple-system,sans-serif;">
  <div style="text-align:center;padding:32px 36px;border-radius:16px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);max-width:360px;">
    <img src="${avatarUrl}" alt="" style="width:64px;height:64px;border-radius:50%;margin-bottom:14px;object-fit:cover;" />
    <h2 style="margin:0 0 8px;font-size:18px;">Signed in as ${user.username.replace(/</g, '&lt;')}</h2>
    <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.65);">You can close this tab and return to Yorumi.</p>
  </div>
</body>
</html>`);
      } catch (error) {
        logger.error('[GlobalChat OAuth] Callback error:', error);
        return res.status(500).send('Discord sign-in failed.');
      }
    });

    app.get('/auth/discord/poll', (req, res) => {
      const state = String(req.query.state || '').trim();
      const session = pendingAuthSessions.get(state);
      if (!session) {
        return res.status(200).json({ ready: false });
      }
      pendingAuthSessions.delete(state);
      return res.status(200).json({ ready: true, token: session.token, user: session.user });
    });

    const getOnlineCount = () => {
      let discordOnline = 0;
      try {
        const channel = this.channels.cache.get(globalChatChannelId);
        if (channel?.guild) {
          discordOnline = channel.guild.memberCount || 0;
        }
      } catch {
        // ignore
      }
      return Math.max(sseClients.size, discordOnline + sseClients.size);
    };

    const formatChatMessage = (msg) => {
      const roleColor = msg.member?.displayHexColor && msg.member.displayHexColor !== '#000000'
        ? msg.member.displayHexColor
        : undefined;
      const author = msg.member?.displayName || msg.author?.globalName || msg.author?.username || 'Discord User';
      const content = msg.content || '';
      const key = `${author}::${content}`;
      const nowWatching = recentNowWatchingByContent.get(key);
      return {
        id: msg.id,
        author,
        avatar: typeof msg.author?.displayAvatarURL === 'function' ? msg.author.displayAvatarURL({ size: 64 }) : undefined,
        color: roleColor,
        content,
        nowWatching,
        timestamp: msg.createdTimestamp || Date.now(),
        fromDiscord: !msg.webhookId,
      };
    };

    const broadcastSse = (data) => {
      const payload = `data: ${JSON.stringify(data)}\n\n`;
      for (const clientRes of sseClients) {
        try {
          clientRes.write(payload);
        } catch {
          sseClients.delete(clientRes);
        }
      }
    };

    if (globalChatChannelId) {
      this.on('messageCreate', (msg) => {
        if (msg.channelId !== globalChatChannelId || !msg.content?.trim()) return;
        broadcastSse(formatChatMessage(msg));
      });

      this.on('messageDelete', (msg) => {
        if (msg.channelId && msg.channelId !== globalChatChannelId) return;
        if (!msg.id) return;
        broadcastSse({ type: 'delete', id: msg.id });
      });

      this.on('messageDeleteBulk', (deletedMessages, channel) => {
        if (channel?.id && channel.id !== globalChatChannelId) return;
        const ids = [...deletedMessages.keys()];
        if (ids.length > 0) {
          broadcastSse({ type: 'deleteBulk', ids });
        }
      });

      this.on('messageUpdate', (_oldMsg, newMsg) => {
        if (newMsg.channelId !== globalChatChannelId || !newMsg.id || !newMsg.content?.trim()) return;
        broadcastSse({ type: 'update', message: formatChatMessage(newMsg) });
      });
    }

    app.get('/chat/history', async (req, res) => {
      if (!globalChatChannelId) {
        return res.status(503).json({ error: 'GLOBAL_CHAT_CHANNEL_ID is not configured' });
      }
      if (!this.isReady()) {
        return res.status(503).json({ error: 'Bot is still connecting to Discord' });
      }
      try {
        const channel = await this.channels.fetch(globalChatChannelId);
        if (!channel || !channel.isTextBased()) {
          return res.status(404).json({ error: 'Global chat channel not found' });
        }
        const fetched = await channel.messages.fetch({ limit: 50 });
        const messages = [...fetched.values()]
          .filter((m) => m.content?.trim())
          .reverse()
          .map(formatChatMessage);
        return res.status(200).json({ messages, onlineCount: getOnlineCount() });
      } catch (error) {
        logger.error('[GlobalChat] Failed to fetch history:', error);
        return res.status(500).json({ error: 'Failed to fetch chat history' });
      }
    });

    app.get('/chat/stream', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      sseClients.add(res);
      broadcastSse({ type: 'presence', onlineCount: getOnlineCount() });

      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(heartbeat);
          sseClients.delete(res);
        }
      }, 25000);

      req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
        broadcastSse({ type: 'presence', onlineCount: getOnlineCount() });
      });
    });

    app.post('/chat/send', async (req, res) => {
      if (!globalChatWebhookUrl) {
        return res.status(503).json({ error: 'GLOBAL_CHAT_WEBHOOK_URL is not configured' });
      }
      const verifiedUser = verifyChatToken(req.body?.token);
      if (discordClientId && discordClientSecret && !verifiedUser) {
        return res.status(401).json({ error: 'Please sign in with Discord to send messages' });
      }
      const username = String(verifiedUser?.username || req.body?.username || 'Yorumi User').trim().slice(0, 32) || 'Yorumi User';
      const avatarUrl = verifiedUser?.avatar || undefined;
      const content = String(req.body?.content || '').trim().slice(0, 500);
      const nowWatching = String(req.body?.nowWatching || '').trim().slice(0, 100);
      if (!content) {
        return res.status(400).json({ error: 'Message content is required' });
      }
      if (nowWatching) {
        const key = `${username}::${content}`;
        recentNowWatchingByContent.set(key, nowWatching);
        setTimeout(() => recentNowWatchingByContent.delete(key), 60_000);
      }
      try {
        const response = await fetch(globalChatWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username,
            avatar_url: avatarUrl,
            content,
            allowed_mentions: { parse: [] },
          }),
        });
        if (!response.ok) {
          const errBody = await response.text().catch(() => '');
          logger.warn(`[GlobalChat] Webhook error (${response.status}): ${errBody}`);
          return res.status(502).json({ error: 'Failed to deliver message to Discord' });
        }
        return res.status(200).json({ ok: true });
      } catch (error) {
        logger.error('[GlobalChat] Failed to send message:', error);
        return res.status(500).json({ error: 'Failed to send message' });
      }
    });

    const startServer = (port, attempt = 0) => {
      let hasStartedListening = false;
      const server = app.listen(port, host, () => {
        hasStartedListening = true;
        this.webServer = server;
        startupLog(`✅ Web Server running on ${host}:${port}`);
        startupLog(`Health endpoint: http://${host}:${port}/health`);
        startupLog(`Ready endpoint: http://${host}:${port}/ready`);
      });

      server.on('error', (error) => {
        const errorCode = error?.code || 'UNKNOWN_ERROR';
        const errorMessage = error?.message || 'Unknown server error';

        if (!hasStartedListening && errorCode === 'EADDRINUSE' && attempt < maxPortRetryAttempts) {
          const nextPort = port + 1;
          startupLog(`Port ${port} is already in use. Trying port ${nextPort}...`);
          setTimeout(() => startServer(nextPort, attempt + 1), 250);
          return;
        }

        if (hasStartedListening && errorCode === 'EADDRINUSE') {
          logger.warn(`Web server reported a duplicate bind warning on ${host}:${port}, but the bot remains online.`);
          return;
        }

        logger.error(`❌ Web server error on port ${port} (${errorCode}): ${errorMessage}`);

        if (!hasStartedListening) {
          process.exit(1);
        }
      });
    };

    startServer(configuredPort, 0);
  }

  setupCronJobs() {
    cron.schedule('0 6 * * *', runSafeTask('birthday_check', () => checkBirthdays(this)));
    cron.schedule('* * * * *', runSafeTask('giveaway_check', () => checkGiveaways(this)));
    cron.schedule('*/15 * * * *', runSafeTask('counter_update', () => this.updateAllCounters()));
  }

  async updateAllCounters() {
    if (!this.db) {
      logger.warn('Database not available for counter updates');
      return;
    }
    
    for (const [guildId, guild] of this.guilds.cache) {
      try {
        const counters = await getServerCounters(this, guildId);
        const validCounters = [];
        const orphanedCounters = [];
        
        for (const counter of counters) {
          if (counter && counter.type && counter.channelId && counter.enabled !== false) {
            const channel = guild.channels.cache.get(counter.channelId);
            if (channel) {
              validCounters.push(counter);
              await updateCounter(this, guild, counter);
            } else {
              orphanedCounters.push(counter);
              logger.info(`Removing orphaned counter ${counter.id} (type: ${counter.type}, deleted channel: ${counter.channelId}) from guild ${guildId}`);
            }
          }
        }
        
        // Save cleaned counters if any were orphaned
        // Save cleaned counters if any were orphaned
        if (orphanedCounters.length > 0) {
          await saveServerCounters(this, guildId, validCounters);
          logger.info(`Cleaned up ${orphanedCounters.length} orphaned counter(s) from guild ${guildId} during scheduled update`);
        }
      } catch (error) {
        logger.error(`Error updating counters for guild ${guildId}:`, error);
      }
    }
  }

  async loadHandlers() {
    startupLog('Loading handlers...');
    const handlers = [
      { path: 'events', type: 'default', required: true },
      { path: 'interactions', type: 'default', required: true }
    ];

    for (const handler of handlers) {
      try {
        startupLog(`Loading handler: ${handler.path}`);
        const module = await import(`./handlers/loaders/${handler.path}.js`);
        const loaderFn = handler.type.startsWith('named:')
          ? module[handler.type.split(':')[1]]
          : module.default;

        if (typeof loaderFn === 'function') {
          await loaderFn(this);
          startupLog(`✅ Loaded ${handler.path}`);
        } else {
          throw new Error(`Invalid loader export from ${handler.path}`);
        }
      } catch (error) {
        if (handler.required) {
          logger.error(`❌ Failed to load required handler ${handler.path}:`, error.message);
          throw error;
        } else if (error.code !== 'MODULE_NOT_FOUND') {
          logger.warn(`⚠️  Failed to load optional handler ${handler.path}:`, error.message);
        }
      }
    }
  }

  async registerCommands() {
    try {
      await registerSlashCommands(this, { clientId: this.config.bot.clientId });
    } catch (error) {
      logger.error('Error registering commands:', error);
    }
  }

  async shutdown(reason = 'UNKNOWN') {
    shutdownLog(`Bot is shutting down (${reason})...`);
    logger.info(`\n${'='.repeat(60)}`);
    logger.info(`🛑 Graceful Shutdown Initiated (${reason})`);
    logger.info(`${'='.repeat(60)}`);

    try {
      
      logger.info('Stopping cron jobs...');
      cron.getTasks().forEach(task => task.stop());
      logger.info('✅ Cron jobs stopped');

      logger.info('Stopping music players...');
      await shutdownMusic(this);
      logger.info('✅ Music players stopped');

      if (this.webServer) {
        logger.info('Closing web server...');
        await new Promise((resolve) => this.webServer.close(resolve));
        logger.info('✅ Web server closed');
      }

      // Close database connection
      // Close database connection
      if (this.db && this.db.db) {
        logger.info('Closing database connection...');
        try {
          if (this.db.db.pool) {
            await this.db.db.pool.end();
            logger.info('✅ Database connection closed');
          }
        } catch (error) {
          logger.warn('Error closing database pool:', error.message);
        }
      }

      logger.info('Destroying Discord client...');
      if (this.isReady()) {
        try {
          this.destroy();
          logger.info('✅ Discord client destroyed');
        } catch (error) {

          logger.warn('Discord client destroy warning (non-critical):', error.message);
        }
      }

      logger.info('✅ Graceful shutdown complete');
  shutdownLog('Bot stopped successfully.');
      process.exit(0);
    } catch (error) {
      logger.error('Error during graceful shutdown:', error);
      process.exit(1);
    }
  }
}

try {
  const bot = new TitanBot();
  
  const setupShutdown = () => {
    process.on('SIGTERM', () => bot.shutdown('SIGTERM'));
    process.on('SIGINT', () => bot.shutdown('SIGINT'));
    
    process.on('uncaughtException', (error) => {
      // Process state may be corrupt after an uncaught throw; log and shut down cleanly.
      handleTaskError('uncaught_exception', error, { fatal: true });
      bot.shutdown('UNCAUGHT_EXCEPTION');
    });

    process.on('unhandledRejection', (reason) => {
      const code = reason?.code;
      if (code === 10062 || code === 40060 || code === 50027) {
        logger.warn('Recoverable Discord interaction rejection:', reason?.message || reason);
        return;
      }
      if (reason?.message?.includes('Queue is empty')) {
        return;
      }

      // A stray rejection is a bug to fix, not a reason to take the bot down.
      // Log loudly with full context; the central task handler categorizes it.
      handleTaskError('unhandled_rejection', reason instanceof Error ? reason : new Error(String(reason)), {
        errorCode: ErrorCodes.UNHANDLED_REJECTION,
      });
    });
  };
  
  setupShutdown();
  bot.start().catch((error) => {
    logger.error('Fatal error during bot startup:', error);
    bot.shutdown('STARTUP_ERROR');
  });
} catch (error) {
  logger.error('Fatal error during bot startup:', error);
  process.exit(1);
}

export default TitanBot;