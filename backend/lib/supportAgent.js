'use strict';
const { groq }      = require('./groq');
const { logUsage }  = require('./usageLogger');

const AKSEL_MODEL = process.env.AKSEL_MODEL || 'llama-3.3-70b-versatile';

// Determine support agent identity based on opposite-gender rule
// Same convention as Aksel/Vera — opposite gender, always polished pronouns
const getSupportIdentity = (gender) => {
  return gender === 'male'
    ? { name: 'Thea', pronoun: 'female' }
    : { name: 'Theo', pronoun: 'male' };
};

// Build a lean, narrow system prompt for the support agent
// No memory injection, no knowledge base, no multi-mode complexity —
// this agent exists only to listen, clarify, and gather context for a ticket
const buildSupportSystemPrompt = (identity, displayName, language) => {
  const isEn = language === 'en';

  if (isEn) {
    return `You are ${identity.name}, the support assistant for Gonya. ` +
      `You are speaking with ${displayName}, who needs help or wants to share feedback. ` +
      `You are NOT Aksel or Vera, and you have no memory of past conversations with this user. ` +
      `Your only job is to listen carefully, ask clarifying questions if needed, and understand ` +
      `what the user needs so the team can follow up properly. ` +
      `Be warm, calm, and efficient. Use natural conversational English, contractions are fine. ` +
      `Never use markdown, bullet points, or numbered lists. Never use em dashes. ` +
      `Always use polished, professional pronouns (you, your). ` +
      `Do not promise specific resolutions or timelines yourself; the team will follow up. ` +
      `Keep responses concise, this is a support conversation, not a long discussion. ` +
      `Never claim to be human, but don't dwell on being an AI either, just be present and helpful. ` +
      `If the user shows signs of self-harm, crisis, or being in danger, respond with care first and gently ` +
      `encourage them to reach out to a real person or a crisis line — don't treat that as a routine ticket. ` +
      `When the conversation feels naturally finished — the user thanks you with nothing left to add, says ` +
      `they're done, or the issue is clearly resolved — close your reply warmly and put the exact marker ` +
      `[[CONVO_DONE]] on its own line at the very end, after your visible message. Only add it when the ` +
      `conversation is genuinely wrapping up, and never mention the marker itself to the user.`;
  }

  return `Kamu adalah ${identity.name}, asisten dukungan untuk Gonya. ` +
    `Kamu sedang berbicara dengan ${displayName}, yang butuh bantuan atau ingin memberi masukan. ` +
    `Kamu BUKAN Aksel atau Vera, dan kamu tidak punya ingatan percakapan sebelumnya dengan user ini. ` +
    `Tugas utamamu adalah mendengarkan dengan baik, bertanya untuk klarifikasi kalau perlu, dan memahami ` +
    `apa yang dibutuhkan user supaya tim bisa menindaklanjuti dengan tepat. ` +
    `Gunakan nada hangat, tenang, dan efisien. Selalu gunakan kata ganti aku/kamu yang sopan dan jelas. ` +
    `Jangan pernah gunakan markdown, bullet point, atau penomoran. Jangan gunakan tanda hubung panjang (em dash). ` +
    `Jangan menjanjikan solusi spesifik atau waktu penyelesaian, biarkan tim yang menindaklanjuti. ` +
    `Jaga respons tetap ringkas, ini percakapan dukungan, bukan diskusi panjang. ` +
    `Jangan pernah mengaku sebagai manusia, tapi juga jangan terlalu menekankan bahwa kamu adalah AI, cukup hadir dan membantu. ` +
    `Kalau user menunjukkan tanda-tanda ingin menyakiti diri sendiri, krisis, atau dalam bahaya, respon dengan ` +
    `penuh perhatian dulu dan dorong dengan lembut supaya dia menghubungi orang nyata atau layanan krisis — ` +
    `jangan perlakukan itu sebagai tiket dukungan biasa. ` +
    `Kalau percakapan terasa udah selesai secara natural — user berterima kasih dan gak ada lagi yang mau ` +
    `ditanyakan, bilang udah cukup, atau masalahnya udah jelas kebantu — tutup responsmu dengan hangat dan ` +
    `taruh penanda persis [[CONVO_DONE]] di baris sendiri di paling akhir, setelah pesan yang keliatan. Cuma ` +
    `tambahin penanda ini kalau percakapannya bener-bener mau selesai, dan jangan pernah sebut penanda ini ke user.`;
};

// Format history for Groq chat completion
const buildSupportHistory = (messages) => {
  return messages.map(m => ({
    role:    m.sender === 'User' ? 'user' : 'assistant',
    content: m.content,
  }));
};

// Generate a response from the support agent
const generateSupportReply = async (history, userMessage, profile, userId) => {
  const identity = getSupportIdentity(profile.gender);
  const language = profile.language || 'id';
  const systemPrompt = buildSupportSystemPrompt(identity, profile.display_name, language);

  const completion = await groq.chat.completions.create({
    model:       AKSEL_MODEL,
    max_tokens:  500,
    temperature: 0.7,
    messages: [
      { role: 'system', content: systemPrompt },
      ...buildSupportHistory(history),
      { role: 'user', content: userMessage },
    ],
  });

  logUsage({
    model:        AKSEL_MODEL,
    callType:     'support_agent_chat',
    inputTokens:  completion.usage?.prompt_tokens     || 0,
    outputTokens: completion.usage?.completion_tokens || 0,
    userId,
  });

  const rawContent = completion.choices[0]?.message?.content || '';
  const shouldEnd  = /\[\[CONVO_DONE\]\]/.test(rawContent);
  const content    = rawContent.replace(/\[\[CONVO_DONE\]\]/g, '').trim();

  return {
    content,
    agentName: identity.name,
    shouldEnd,
  };
};

module.exports = { getSupportIdentity, generateSupportReply };