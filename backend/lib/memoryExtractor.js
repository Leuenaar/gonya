'use strict';
const { groq }     = require('./groq');
const { supabase } = require('./supabase');
const { logUsage } = require('./usageLogger');

const AKSEL_MODEL = process.env.AKSEL_MODEL || 'openai/gpt-oss-120b'; // llama-3.3-70b-versatile deprecated by Groq (17 Jun 2026) — same migration as groupJudge.js/groupAkselTrigger.js/handler.js

// How many of the user's existing memories to show the model as "already
// known" context. Fixes the exact gap surfaced by user-reported evidence
// (22 Aug 2026, screenshots of the pending-review queue): a "skip if not
// genuinely new" instruction is unenforceable if the model is never shown
// what's already there to compare against — the SAME fix already applied
// to groupMemoryExtractor.js's extractGroupMemory() from the start.
const EXISTING_MEMORY_CONTEXT_LIMIT = 30;

// Layer 1: content-level insight extraction from a single exchange
// Runs after every chat turn — fire-and-forget, never blocks response
const extractLayer1 = async (userId, userMessage, agentResponses) => {
  try {
    const agentText = agentResponses
      .map(r => `${r.agent}: ${r.content}`)
      .join('\n\n');

    const { data: existing } = await supabase
      .from('memories')
      .select('content')
      .eq('user_id', userId)
      .in('status', ['pending', 'approved'])
      .order('created_at', { ascending: false })
      .limit(EXISTING_MEMORY_CONTEXT_LIMIT);

    const existingList = (existing || []).map(m => `- ${m.content}`).join('\n') || '(none yet)';

    // Rewritten (22 Aug 2026) after user-reported evidence of two compounding
    // problems in the pending-review queue: (1) the same fact re-extracted
    // repeatedly in slightly different phrasing (fixed above via
    // existingList), and (2) a "worth remembering" bar that was far too
    // low — one-off task requests, single clarifying questions, and
    // transient technical hiccups were all getting captured as if they were
    // durable facts about the user. Bar is now grounded in how ChatGPT's own
    // memory selection actually works (researched 22 Aug 2026): it favors
    // repeated/recurring signals and a small set of inherently-stable
    // identity facts over one-off details — not "everything that was said."
    const prompt =
      `You are analyzing a conversation to extract DURABLE, long-term-worthy facts about the user — ` +
      `not a transcript of everything they said.\n\n` +
      `User message:\n"${userMessage}"\n\n` +
      `Agent responses:\n${agentText}\n\n` +
      `Already known about this user:\n${existingList}\n\n` +
      `Extract 0 to 2 insights that would genuinely help a FUTURE conversation — think of this like ` +
      `learning to drive: you don't need to remember every shop you passed on the way, you need the ` +
      `durable skill and pattern. Only extract:\n` +
      `- Stable identity/context facts (occupation, an ongoing project name, location, relationships, ` +
      `tools or stack they use) — fine to capture from a single clear mention, since these rarely change.\n` +
      `- A preference EXPLICITLY framed as a standing/general instruction ("always respond in ` +
      `English", "I prefer short answers") — not a one-off request.\n` +
      `- A genuine long-term goal or project they are actively pursuing over time.\n\n` +
      `Do NOT extract:\n` +
      `- One-off task or command requests ("count to 10", "adjust the tempo", "generate a file") — ` +
      `these are instructions for THIS turn, not facts about who the user is.\n` +
      `- A single clarifying question ("what did you say?", "can you repeat that?") reframed as a ` +
      `"preference" — that's normal conversational repair, not a pattern.\n` +
      `- Transient technical or support issues (a connection problem, an error they hit) — momentary ` +
      `state, not a durable fact.\n` +
      `- A passing mention of interest with no repetition or clear emphasis — wait for a pattern ` +
      `before capturing something like that.\n` +
      `- Anything that duplicates or closely paraphrases something already listed above as "already ` +
      `known" — only genuinely new information belongs in your answer.\n\n` +
      `Each insight must be a single sentence, 10 to 30 words. Return ONLY a JSON array — no ` +
      `explanation, no markdown, no preamble.\n\n` +
      `Format: [{ "content": "...", "category": "goal|context|preference|concern|behavior" }]\n\n` +
      `If nothing durable and new, return: []`;

    const completion = await groq.chat.completions.create({
      model:       AKSEL_MODEL,
      max_tokens:  400,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    });

    logUsage({
      model:        AKSEL_MODEL,
      callType:     'memory_extract_layer1',
      inputTokens:  completion.usage?.prompt_tokens     || 0,
      outputTokens: completion.usage?.completion_tokens || 0,
      userId,
    });

    const raw = completion.choices[0]?.message?.content || '[]';
    let insights;
    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      insights = JSON.parse(clean);
    } catch {
      console.warn('[Memory] Layer 1 parse failed, skipping');
      return;
    }

    if (!Array.isArray(insights) || insights.length === 0) return;

    const rows = insights
      .filter(i => i.content && i.category)
      .map(i => ({
        user_id:      userId,
        content:      i.content,
        layer:        1,
        category:     i.category,
        status:       'pending',
        agent_target: 'Both',
      }));

    if (rows.length === 0) return;

    const { error } = await supabase.from('memories').insert(rows);
    if (error) console.error('[Memory] Layer 1 insert error:', error.message);
    else console.log(`[Memory] Layer 1: ${rows.length} insight(s) queued for user ${userId}`);
  } catch (err) {
    console.error('[Memory] Layer 1 extraction error:', err.message);
  }
};

// Layer 2: passive behavioral pattern extraction
// Runs at most once every 12 hours per user to avoid duplicate patterns
//
// NOT touched by the 22 Aug 2026 rework above — this is a deterministic
// statistical computation (average message length, peak active hour from
// 50+ messages), not an LLM judgment call about what's "worth
// remembering," so it doesn't have the same noise/over-extraction
// failure mode extractLayer1 had. Already well-scoped: throttled to
// 12h, requires 5+ messages, always produces exactly the same 2
// fixed-format behavioral facts.
const extractLayer2 = async (userId) => {
  try {
    // Throttle: skip if Layer 2 ran in the last 12 hours
    const { data: recent } = await supabase
      .from('memories')
      .select('created_at')
      .eq('user_id', userId)
      .eq('layer', 2)
      .order('created_at', { ascending: false })
      .limit(1);

    if (recent?.length > 0) {
      const hoursSince = (Date.now() - new Date(recent[0].created_at).getTime()) / (1000 * 60 * 60);
      if (hoursSince < 12) return;
    }

    // Need at least 5 user messages to detect patterns
    const { data: messages, error } = await supabase
      .from('messages')
      .select('content, created_at')
      .eq('user_id', userId)
      .eq('sender', 'User')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error || !messages || messages.length < 5) return;

    // Average message length
    const avgLength = Math.round(
      messages.reduce((sum, m) => sum + m.content.length, 0) / messages.length
    );

    // Peak active hour in WIB (UTC+7)
    const hourCounts = {};
    for (const msg of messages) {
      const wibHour = (new Date(msg.created_at).getUTCHours() + 7) % 24;
      hourCounts[wibHour] = (hourCounts[wibHour] || 0) + 1;
    }
    const peakHour = parseInt(
      Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0]?.[0],
      10
    );

    const peakLabel =
      peakHour < 6  ? 'dini hari'   :
      peakHour < 12 ? 'pagi'        :
      peakHour < 15 ? 'siang'       :
      peakHour < 18 ? 'sore'        :
      peakHour < 21 ? 'malam'       : 'malam larut';

    const styleLabel =
      avgLength < 50  ? 'Tends to write short, concise messages' :
      avgLength < 150 ? 'Writes messages of moderate length'     :
                        'Often writes detailed, longer messages';

    const patterns = [
      { content: styleLabel,                                                    category: 'behavior' },
      { content: `Most active during ${peakLabel} (around ${peakHour}:00 WIB)`, category: 'behavior' },
    ];

    const rows = patterns.map(p => ({
      user_id:      userId,
      content:      p.content,
      layer:        2,
      category:     p.category,
      status:       'pending',
      agent_target: 'Both',
    }));

    const { error: insertError } = await supabase.from('memories').insert(rows);
    if (insertError) console.error('[Memory] Layer 2 insert error:', insertError.message);
    else console.log(`[Memory] Layer 2: ${rows.length} pattern(s) queued for user ${userId}`);
  } catch (err) {
    console.error('[Memory] Layer 2 extraction error:', err.message);
  }
};

module.exports = { extractLayer1, extractLayer2 };
