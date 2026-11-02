'use strict';
const { supabase }    = require('../lib/supabase');
const { searchRegistry, saveToRegistry, normalizeDomain, evaluateRelevance } = require('./registry');
const { generateKnowledge } = require('./generator');
const { getSourcesForUser } = require('../lib/newsLibrary');

const THEONES_MODEL = process.env.THEONES_MODEL || 'claude-opus-4-8';

const runOnboarding = async ({ userId, domain, gender, languageStyle, taxonomyPath, clarifyingAnswers }) => {
  console.log(`[TheOnes] Onboarding user ${userId} — "${domain}"`);

  // ── Relevance check ───────────────────────────────────────
  const relevance = evaluateRelevance(domain);
  if (!relevance.valid) {
    console.warn(`[TheOnes] Rejected: "${domain}" — ${relevance.reason}`);
    return { status: 'rejected', reason: relevance.reason };
  }

  const normalized = normalizeDomain(domain);

  // ── Registry lookup ───────────────────────────────────────
  const registryResult = await searchRegistry(normalized);
  console.log(`[TheOnes] Registry: ${registryResult.type} (score: ${registryResult.score.toFixed(2)})`);

  let knowledge;

  if (registryResult.type === 'hit') {
    knowledge = {
      category:          registryResult.data.category,
      subcategory:       registryResult.data.subcategory || null,
      akselKnowledge:    registryResult.data.aksel_knowledge,
      veraKnowledge:     registryResult.data.vera_knowledge,
      akselPersona:      null,
      veraPersona:       null,
      agentArchitecture: null,
      memorySeeds:       null,
    };

    try {
      const fresh = await generateKnowledge({ domain, gender, languageStyle, taxonomyPath, clarifyingAnswers });
      knowledge.akselPersona      = fresh.akselPersona;
      knowledge.veraPersona       = fresh.veraPersona;
      knowledge.agentArchitecture = fresh.agentArchitecture;
      knowledge.memorySeeds       = fresh.memorySeeds;
    } catch (err) {
      console.warn('[TheOnes] Fresh persona failed, using defaults:', err.message);
    }

  } else {
    knowledge = await generateKnowledge({ domain, gender, languageStyle, taxonomyPath, clarifyingAnswers });

    if (registryResult.type === 'miss' && (knowledge.relevanceScore || 0) >= 0.6) {
      await saveToRegistry({
        domain,
        normalizedDomain: normalized,
        category:         knowledge.category,
        subcategory:      knowledge.subcategory,
        akselKnowledge:   knowledge.akselKnowledge,
        veraKnowledge:    knowledge.veraKnowledge,
      });
    } else if (registryResult.type === 'miss') {
      console.log(`[TheOnes] Registry save skipped — relevance too low (${knowledge.relevanceScore})`);
    }
  }

  // ── Save knowledge_base ───────────────────────────────────
  const { error: kbError } = await supabase.from('knowledge_base').insert([
    { user_id: userId, agent_target: 'Aksel', category: knowledge.category, content: knowledge.akselKnowledge, source: registryResult.type === 'hit' ? 'registry' : 'theones' },
    { user_id: userId, agent_target: 'Vera',  category: knowledge.category, content: knowledge.veraKnowledge,  source: registryResult.type === 'hit' ? 'registry' : 'theones' },
  ]);
  if (kbError) console.error('[TheOnes] KB error:', kbError.message);

  // ── Build full persona prompts with architecture ──────────
  const akselDominant = gender === 'male';
  const arch          = knowledge.agentArchitecture || {};

  const buildPersona = (base, triggers, forbidden, protocol) => {
    let p = base || '';
    if (triggers?.length)  p += `\n\nLead when: ${triggers.join('; ')}.`;
    if (forbidden?.length) p += `\n\nNever: ${forbidden.join('; ')}.`;
    if (protocol)          p += `\n\nHandoff: ${protocol}`;
    return p.trim();
  };

  const akselFull = buildPersona(knowledge.akselPersona, arch.aksel_triggers, arch.forbidden_patterns, arch.collaboration_protocol);
  const veraFull  = buildPersona(knowledge.veraPersona,  arch.vera_triggers,  arch.forbidden_patterns, arch.collaboration_protocol);

  // ── Upsert agent_configs ──────────────────────────────────
  const { error: configError } = await supabase.from('agent_configs').upsert([
    { user_id: userId, agent: 'Aksel', domain, persona_prompt: akselFull, is_dominant: akselDominant  },
    { user_id: userId, agent: 'Vera',  domain, persona_prompt: veraFull,  is_dominant: !akselDominant },
  ], { onConflict: 'user_id,agent' });
  if (configError) console.error('[TheOnes] agent_configs error:', configError.message);

  // ── Insert pre-seeded memories ────────────────────────────
  if (knowledge.memorySeeds) {
    const seeds = [
      ...(knowledge.memorySeeds.layer1 || []).map(m => ({
        user_id: userId, agent_target: m.agent, layer: 1,
        category: m.category, content: m.content,
        status: 'approved', confidence: 1,
      })),
      ...(knowledge.memorySeeds.layer2 || []).map(m => ({
        user_id: userId, agent_target: m.agent, layer: 2,
        category: m.category, content: m.content,
        status: 'approved', confidence: 1,
      })),
    ];

    if (seeds.length > 0) {
      const { error: memError } = await supabase.from('memories').insert(seeds);
      if (memError) console.error('[TheOnes] Memory seed error:', memError.message);
      else          console.log(`[TheOnes] Pre-seeded ${seeds.length} memories for user ${userId}`);
    }
  }

  // ── Update onboarding step ────────────────────────────────
  await supabase.from('user_profiles').update({ onboarding_step: 2 }).eq('id', userId);

  console.log(`[TheOnes] Onboarding complete for user ${userId}`);
  return {
    status:      'success',
    registry:    registryResult.type,
    category:    knowledge.category,
    subcategory: knowledge.subcategory,
  };
};

const runEvolution = async ({ userId }) => {
  console.log(`[TheOnes] Evolution for user ${userId}`);

  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: messages } = await supabase
      .from('messages')
      .select('sender, content, created_at')
      .eq('user_id', userId)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(100);

    if (!messages || messages.length < 5) {
      return { status: 'skipped', reason: 'insufficient_messages' };
    }

    const { anthropic } = require('../lib/anthropic');
    const transcript = messages.map(m => `${m.sender}: ${m.content}`).join('\n');

    const prompt = `You are TheOnes, analyzing conversation history to extract behavioral insights.

CONVERSATION (last 7 days):
${transcript}

Extract observations at three layers. Respond ONLY with valid JSON:
{
  "layer1": [{ "agent": "Aksel|Vera|Both", "category": "topic", "content": "what user discussed" }],
  "layer2": [{ "agent": "Aksel|Vera|Both", "category": "pattern", "content": "how user communicates" }],
  "layer3": [{ "agent": "Aksel|Vera|Both", "category": "gap", "content": "what user never says but implies", "confidence": 1|2|3 }]
}

Rules: Layer 1 max 3 entries, Layer 2 max 2 entries, Layer 3 max 1 entry (only if confidence >= 2). Empty array if no clear insight.`;

    const response = await anthropic.messages.create({
      model:       THEONES_MODEL,
      max_tokens:  1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text   = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const match  = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in evolution response');
    const result = JSON.parse(match[0]);

    const entries = [
      ...(result.layer1 || []).map(m => ({ user_id: userId, agent_target: m.agent, layer: 1, category: m.category, content: m.content, status: 'pending', confidence: 1 })),
      ...(result.layer2 || []).map(m => ({ user_id: userId, agent_target: m.agent, layer: 2, category: m.category, content: m.content, status: 'pending', confidence: 1 })),
      ...(result.layer3 || []).filter(m => m.confidence >= 2).map(m => ({ user_id: userId, agent_target: m.agent, layer: 3, category: m.category, content: m.content, status: 'pending', confidence: m.confidence })),
    ];

    if (entries.length > 0) await supabase.from('memories').insert(entries);

    console.log(`[TheOnes] Evolution complete — ${entries.length} memories for user ${userId}`);
    return { status: 'success', memoriesExtracted: entries.length };

  } catch (err) {
    console.error('[TheOnes] Evolution error:', err.message);
    return { status: 'error', message: err.message };
  }
};

// ── News librarian — selects relevant sources from the library ─
const selectNewsSources = (language, radarCategories) => {
  const sources = getSourcesForUser(language, radarCategories);
  console.log(
    `[TheOnes] News library — ${sources.length} sources selected` +
    ` (lang: ${language || 'id'}, categories: ${(radarCategories || []).join(', ') || 'none'})`
  );
  return sources;
};

module.exports = { runOnboarding, runEvolution, selectNewsSources };