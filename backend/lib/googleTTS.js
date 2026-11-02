'use strict';
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');

// ── Credentials ────────────────────────────────────────────────────────────
// Loaded from a SINGLE-LINE env var containing the full service account
// JSON key (minified — no literal newlines), not a file path. Keeps the
// credential out of the repo/filesystem entirely, consistent with how the
// other providers in this project (Groq, Tavily, Deepgram) keep their
// secrets purely in .env rather than as files on disk.
//
// Confirmed from official Google Cloud Node.js client docs: TextToSpeechClient
// accepts a `credentials` object directly in its constructor options —
// JSON.parse() the env var and pass it straight in, no GOOGLE_APPLICATION_
// CREDENTIALS file-path env var needed.
const credentialsJson = process.env.GOOGLE_TTS_CREDENTIALS_JSON;

if (!credentialsJson) {
  throw new Error('[GoogleTTS] Missing GOOGLE_TTS_CREDENTIALS_JSON in .env');
}

let credentials;
try {
  credentials = JSON.parse(credentialsJson);
} catch (err) {
  throw new Error(`[GoogleTTS] GOOGLE_TTS_CREDENTIALS_JSON is not valid JSON: ${err.message}`);
}

const client = new TextToSpeechClient({ credentials });

console.log(`[GoogleTTS] Client initialized for service account "${credentials.client_email}".`);

// ── Diagnostic helper: list actual available Indonesian voices ─────────────
// NOT called automatically anywhere yet. Exported so it can be run once
// during setup/testing to confirm the EXACT voice names Google has for
// id-ID (Standard tier, per the free-tier decision) before hardcoding
// GOOGLE_VOICE_AKSEL_ID / GOOGLE_VOICE_VERA_ID defaults in voiceSession.js —
// deliberately not guessing names that weren't verified.
async function listIndonesianVoices() {
  const [result] = await client.listVoices({ languageCode: 'id-ID' });
  return result.voices || [];
}

// ── Synthesize one sentence, return a Buffer ready to send over the WS ─────
// audioEncoding: 'LINEAR16' — confirmed from official Google Cloud docs,
// LINEAR16 output ALREADY includes a WAV header (same as MP3/OGG_OPUS
// container formats). This is the exact same container Deepgram Aura's TTS
// output uses in this project (encoding: 'linear16', container: 'wav'), so
// ttsAndSend()'s `ws.send(buf)` and the client-side playback code need ZERO
// changes to handle audio from either provider.
async function synthesize(text, voiceName) {
  const [response] = await client.synthesizeSpeech({
    input: { text },
    voice: { languageCode: 'id-ID', name: voiceName },
    audioConfig: { audioEncoding: 'LINEAR16' },
  });
  // The Node client library returns protobuf `bytes` fields as a Buffer
  // already — Buffer.isBuffer guard here is defensive (harmless either way:
  // Buffer.from() on an existing Buffer just copies it) in case a future
  // client library version ever returns a base64 string instead.
  return Buffer.isBuffer(response.audioContent)
    ? response.audioContent
    : Buffer.from(response.audioContent, 'binary');
}

module.exports = { synthesize, listIndonesianVoices };
