'use strict';
const { anthropic } = require('../lib/anthropic');

const THEONES_MODEL = process.env.THEONES_MODEL || 'claude-opus-4-8';
const HAIKU_MODEL   = 'claude-haiku-4-5-20251001';

// ── Layer 1: Generate clarifying questions via Haiku ──────
const generateQuestions = async ({ domain, gender, languageStyle }) => {
  const response = await anthropic.messages.create({
    model:      HAIKU_MODEL,
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `You are TheOnes, the intelligence layer of The Triangle platform.

A user wants to use The Triangle for: "${domain}"
Gender: ${gender} | Language style: ${languageStyle}

Generate exactly 3 targeted clarifying questions that will help build a deeply personalized knowledge base.
Each question must have exactly 4 short, specific options.
Questions must be relevant to "${domain}" — not generic.

Respond ONLY with valid JSON starting with {:
{
  "questions": [
    { "id": "q1", "text": "question?", "options": ["A", "B", "C", "D"] },
    { "id": "q2", "text": "question?", "options": ["A", "B", "C", "D"] },
    { "id": "q3", "text": "question?", "options": ["A", "B", "C", "D"] }
  ]
}`
    }]
  });

  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in questions response');
  return JSON.parse(match[0]);
};

// ── Layer 2-4: Deep research + Architecture + Memory seeds ─
const generateKnowledge = async ({ domain, gender, languageStyle, taxonomyPath, clarifyingAnswers }) => {
  const akselRole = gender === 'female'
    ? 'psychological support and strategic execution partner'
    : 'dominant execution-oriented COO and strategic lead';
  const veraRole = gender === 'female'
    ? 'dominant research lead, primary strategist, and analytical backbone'
    : 'research lead, analytical support, and depth provider';

  const categoryCtx = taxonomyPath
    ? `Category: ${taxonomyPath.category} → ${taxonomyPath.subcategory}`
    : `Domain: ${domain}`;

  const answersCtx = clarifyingAnswers && Object.keys(clarifyingAnswers).length > 0
    ? Object.values(clarifyingAnswers).map(v => `• ${v}`).join('\n')
    : 'No additional context.';

  const prompt = `You are TheOnes, the hidden intelligence layer of The Triangle platform.
Your task: build a deeply personalized, expert-level knowledge system for two AI agents.

══════════════════════════════════
USER PROFILE
══════════════════════════════════
Domain       : ${domain}
${categoryCtx}
Gender       : ${gender}
Lang style   : ${languageStyle}
User context :
${answersCtx}

══════════════════════════════════
RESEARCH PROTOCOL — MANDATORY
══════════════════════════════════
You MUST run at least 4 web searches before generating output:
1. "${domain} fundamentals framework best practices 2026"
2. "${domain} common mistakes failure patterns pitfalls"
3. "${domain} metrics benchmarks tools resources 2026"
4. "${domain} strategy execution ${Object.values(clarifyingAnswers || {}).join(' ')}"

Do NOT generate the JSON until all searches are complete.
Use findings to make knowledge specific, not generic.

══════════════════════════════════
OUTPUT — ONLY JSON, START WITH {
══════════════════════════════════
{
  "category": "parent category (Research/Business/Technology/Career/Creative)",
  "subcategory": "specific subcategory",
  "relevance_score": 0.0,

  "aksel_knowledge": "700-900 words for Aksel (${akselRole}). Must include: execution frameworks specific to ${domain} + user context, concrete action playbooks, decision-making criteria, KPIs to track, timeline structures, failure patterns to avoid. MUST reference findings from web searches. Make it specific to: ${answersCtx}",

  "vera_knowledge": "700-900 words for Vera (${veraRole}). Must include: analytical frameworks for ${domain} + user context, research methodologies, key data sources and benchmarks, behavioral signals to watch, strategic risk factors, how to interpret domain-specific patterns. MUST reference findings from web searches. Make it specific to: ${answersCtx}",

  "aksel_persona": "3-4 sentences defining Aksel's communication style, what he prioritizes, when he speaks first, and how he adapts to this user's gender (${gender}) and language style (${languageStyle}).",

  "vera_persona": "3-4 sentences defining Vera's communication style, what she prioritizes, when she speaks first, and how she adapts to this user's gender (${gender}) and language style (${languageStyle}).",

  "agent_architecture": {
    "aksel_triggers": [
      "specific situation 1 when Aksel leads",
      "specific situation 2 when Aksel leads",
      "specific situation 3 when Aksel leads"
    ],
    "vera_triggers": [
      "specific situation 1 when Vera leads",
      "specific situation 2 when Vera leads",
      "specific situation 3 when Vera leads"
    ],
    "forbidden_patterns": [
      "what neither agent should do with this specific user",
      "another behavioral pattern to avoid"
    ],
    "collaboration_protocol": "1-2 sentences on how Aksel and Vera hand off to each other for this user."
  },

  "memory_seeds": {
    "layer1": [
      { "agent": "Aksel", "category": "domain_context", "content": "Specific factual knowledge about this user's domain and situation from onboarding" },
      { "agent": "Vera",  "category": "analytical_baseline", "content": "The analytical starting point and key research areas for this user's context" }
    ],
    "layer2": [
      { "agent": "Both", "category": "communication_pattern", "content": "Inferred communication preferences based on their gender, language style, and clarifying answers" }
    ]
  }
}`;

  const response = await anthropic.messages.create({
    model:      THEONES_MODEL,
    max_tokens: 6000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages:   [{ role: 'user', content: prompt }]
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('[TheOnes] Raw response snippet:', text.slice(0, 300));
    throw new Error('No JSON found in TheOnes response');
  }

  const result = JSON.parse(match[0]);
  const stripCites = (text) => text ? text.replace(/<cite[^>]*>|<\/cite>/g, '') : text;
  result.aksel_knowledge = stripCites(result.aksel_knowledge);
  result.vera_knowledge  = stripCites(result.vera_knowledge);

  return {
    category:          result.category,
    subcategory:       result.subcategory,
    relevanceScore:    result.relevance_score,
    akselKnowledge:    result.aksel_knowledge,
    veraKnowledge:     result.vera_knowledge,
    akselPersona:      result.aksel_persona,
    veraPersona:       result.vera_persona,
    agentArchitecture: result.agent_architecture,
    memorySeeds:       result.memory_seeds,
  };
};

module.exports = { generateQuestions, generateKnowledge };