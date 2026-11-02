'use strict';
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const healthRouter   = require('./routes/health');
const userRouter     = require('./routes/user');
const theonesRouter  = require('./routes/theones');
const chatRouter     = require('./routes/chat');
const newsRouter     = require('./routes/news');
const safetyRouter   = require('./routes/safety');
const adminRouter    = require('./routes/admin');
const filesRouter    = require('./routes/files');
const dossiersRouter = require('./routes/dossiers');
const memoriesRouter = require('./routes/memories');
const tasksRouter    = require('./routes/tasks');
const notesRouter    = require('./routes/notes');
const currencyRouter = require('./routes/currency');
const calendarRouter = require('./routes/calendar');
const feedbackRouter = require('./routes/feedback');
const agePatternsRouter   = require('./routes/agePatterns');
const groupsRouter        = require('./routes/groups');
const groupInvitesRouter  = require('./routes/groupInvites');
const groupMessagesRouter = require('./routes/groupMessages');
const groupMemoriesRouter = require('./routes/groupMemories');
const invitesRouter       = require('./routes/invites');

const { attachVoiceServer } = require('./voice/voiceSession');
const { attachVoiceServerMobile } = require('./voice/voiceSessionMobile');
const { runGlobalEventsScan } = require('./cron/globalEventsScanner');
const { runDemoCleanup } = require('./cron/demoCleanup');

const app  = express();
const PORT = process.env.PORT || 3000;

// CORS: local dev origins are always allowed; FRONTEND_URL adds the real
// deployed frontend on top of that once it's set in production.
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:4173',
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
];

app.use(cors({
  origin:      allowedOrigins,
  credentials: true,
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.use('/api/health',    healthRouter);
app.use('/api/user',      userRouter);
app.use('/api/theones',   theonesRouter);
app.use('/api/chat',      chatRouter);
app.use('/api/news',      newsRouter);
app.use('/api/safety',    safetyRouter);
app.use('/api/admin',     adminRouter);
app.use('/api/files',     filesRouter);
app.use('/api/dossiers',  dossiersRouter);
app.use('/api/memories',  memoriesRouter);
app.use('/api/tasks',     tasksRouter);
app.use('/api/notes',     notesRouter);
app.use('/api/currency',  currencyRouter);
app.use('/api/calendar',  calendarRouter);
app.use('/api/feedback',  feedbackRouter);
app.use('/api/age-patterns', agePatternsRouter);
app.use('/api/groups',               groupsRouter);
app.use('/api/groups/:id/invites',   groupInvitesRouter);
app.use('/api/groups/:id/messages',  groupMessagesRouter);
app.use('/api/groups/:id/memories',  groupMemoriesRouter);
app.use('/api/invites',              invitesRouter);

// Bug fixed (12 Sep 2026): this route was originally placed AFTER the
// catch-all 404 handler below — in Express, middleware/routes match in
// DEFINITION ORDER, so every single request to this endpoint was being
// silently swallowed by that catch-all and returning 404 before this
// handler ever ran. Confirmed via real testing: the request-logging
// middleware at the top of this file DID show "POST /api/debug-log" in
// pm2 logs (it runs before route matching), but the actual message this
// route is supposed to print never once appeared — several rondes of
// mobile voice-call debugging were built on "clean logs" that were
// actually just this endpoint never having run at all. Moved above the
// catch-all so it's actually reachable. Also switched console.warn to
// console.log — PM2 splits stdout/stderr into separate log files, and
// warn's stderr routing was one more way this could get missed even
// once it does run.
//
// TEMPORARY diagnostic endpoint — remove once the mobile voice-call-
// drops investigation concludes. Mobile browser devtools access (USB
// debugging auth, Eruda, Opera remote debug) all hit friction during
// this investigation — this lets client-side JS post a plain text
// message that shows up right here in `pm2 logs`, far easier to access
// reliably than any mobile browser console. Unauthenticated on purpose
// — the moment being debugged is often a component UNMOUNTING, and an
// auth-header dependency is one more thing that could silently fail
// exactly when this log is needed most.
// Disabled unless ENABLE_CLIENT_DEBUG=true, because the route is
// unauthenticated by design. Messages are truncated before logging.
if (process.env.ENABLE_CLIENT_DEBUG === 'true') {
  app.post('/api/debug-log', (req, res) => {
    const raw = typeof req.body?.message === 'string' ? req.body.message : '(empty message)';
    console.log('[ClientDebug]', raw.slice(0, 500));
    res.json({ status: 'ok' });
  });
}

app.use((req, res) => {
  res.status(404).json({ status: 'error', message: `Not found: ${req.method} ${req.path}` });
});

app.use((err, _req, res, _next) => {
  console.error('[Error]', err);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
});

// Daily global events scan — runs at midnight UTC
cron.schedule('0 0 * * *', () => {
  runGlobalEventsScan();
}, { timezone: 'UTC' });

// Daily demo-account cleanup — runs at 1am UTC (offset from the events
// scan above so the two don't fire at the exact same moment). Deletes
// anonymous (demo) accounts older than 30 days — see
// cron/demoCleanup.js's own comment for the full cascade-delete reasoning.
cron.schedule('0 1 * * *', () => {
  runDemoCleanup();
}, { timezone: 'UTC' });

const server = app.listen(PORT, () => {
  console.log(`\n[ Gonya ] Backend running on port ${PORT}`);
  console.log(`  Health    : http://localhost:${PORT}/api/health`);
  console.log(`  TheOnes   : http://localhost:${PORT}/api/theones/onboard`);
  console.log(`  Chat      : http://localhost:${PORT}/api/chat/send`);
  console.log(`  News      : http://localhost:${PORT}/api/news/macro`);
  console.log(`  Safety    : http://localhost:${PORT}/api/safety/resources`);
  console.log(`  Admin     : http://localhost:${PORT}/api/admin/health`);
  console.log(`  Files     : http://localhost:${PORT}/api/files`);
  console.log(`  Memories  : http://localhost:${PORT}/api/memories/pending`);
  console.log(`  Tasks     : http://localhost:${PORT}/api/tasks`);
  console.log(`  Notes     : http://localhost:${PORT}/api/notes`);
  console.log(`  Currency  : http://localhost:${PORT}/api/currency/usd-idr`);
  console.log(`  Calendar  : http://localhost:${PORT}/api/calendar/events`);
  console.log(`  Feedback  : http://localhost:${PORT}/api/feedback`);
  console.log(`  Groups    : http://localhost:${PORT}/api/groups`);
  console.log(`  Voice     : ws://localhost:${PORT}/ws/voice (desktop)`);
  console.log(`  Voice     : ws://localhost:${PORT}/ws/voice-mobile (mobile)\n`);

  // Run once on startup so you don't have to wait until midnight to see
  // results — but ONLY in production. In dev, nodemon restarts on every
  // file save, and this was firing (and burning Haiku tokens) every time.
  if (process.env.NODE_ENV === 'production') {
    runGlobalEventsScan();
    runDemoCleanup();
  } else {
    console.log('  [GlobalEvents] Skipping startup scan — NODE_ENV is not "production".');
  }
});

// Bug fixed (13 Sep 2026): confirmed via research — the `ws` library
// cannot have two WebSocketServer instances each independently bound
// (via the `server:` option) to the SAME httpServer, even at different
// paths; the second one breaks the first (well-documented `ws` library
// limitation, not specific to this project). Both attach functions now
// return a `noServer: true` instance instead, and this ONE 'upgrade'
// listener is the single place that inspects the incoming request's path
// and manually dispatches to whichever instance should handle it —
// this is the standard, correct pattern for multiple WS paths sharing
// one HTTP server.
const wssDesktop = attachVoiceServer();
const wssMobile  = attachVoiceServerMobile();

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);

  if (pathname === '/ws/voice') {
    wssDesktop.handleUpgrade(request, socket, head, (ws) => {
      wssDesktop.emit('connection', ws, request);
    });
  } else if (pathname === '/ws/voice-mobile') {
    wssMobile.handleUpgrade(request, socket, head, (ws) => {
      wssMobile.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

module.exports = app;