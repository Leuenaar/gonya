'use strict';
/**
 * Group Onboarding Orchestrator (Phase 8.1, Step 1.5)
 *
 * Runs the 4-phase TheOnes pipeline for a new group:
 *   Phase 1 — Project Definition  (purpose, scope, goals)
 *   Phase 2 — Milestones          (key objectives, rough timeline)
 *   Phase 3 — Team Context        (member roles and expertise)
 *   Phase 4 — Agent Configuration (how Aksel/Vera serve this group)
 *
 * Mirrors the personal orchestrator.js pattern — Haiku for cheap prep
 * work, Opus for the substantive reasoning phases. Output is stored in
 * the groups table (purpose, milestones, agent_config) and
 * onboarding_done is flipped to true when complete.
 */
const { anthropic } = require('../lib/anthropic');
const { supabase }  = require('../lib/supabase');
const { logUsage }  = require('../lib/usageLogger');

const THEONES_MODEL = process.env.THEONES_MODEL || 'claude-opus-4-8';
const HAIKU_MODEL   = 'claude-haiku-4-5-20251001';

// ── Helpers ──────────────────────────────────────────────────────────────────

const parseJson = (text) => {
  const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON found in model response');
  return JSON.parse(match[0]);
};

const callModel = async (model, messages, maxTokens, userId, callType) => {
  const response = await anthropic.messages.create({ model, max_tokens: maxTokens, messages });
  logUsage({
    model,
    callType,
    inputTokens:  response.usage?.input_tokens  || 0,
    outputTokens: response.usage?.output_tokens || 0,
    userId,
  });
  return response.content.filter(b => b.type === 'text').map(b => b.text).join('');
};

// ── Phase 1 — Generate clarifying questions (Haiku, cheap) ───────────────────
// Called from the frontend to start the onboarding conversation. Returns 3
// questions the owner answers before Phase 2 runs.
const generateGroupQuestions = async ({ groupName, userId }) => {
  const text = await callModel(HAIKU_MODEL, [{
    role: 'user',
    content:
      `You are TheOnes, the intelligence layer of Gonya.\n\n` +
      `A user is setting up a new collaboration group called "${groupName}".\n\n` +
      `Generate exactly 3 targeted questions to understand what this group is for.\n` +
      `Each question must have exactly 4 short, specific options.\n` +
      `Focus on: (1) the group's primary purpose/domain, (2) working style or ` +
      `collaboration rhythm, (3) the main outcome or deliverable they're working toward.\n\n` +
      `Respond ONLY with valid JSON:\n` +
      `{\n` +
      `  "questions": [\n` +
      `    { "id": "q1", "text": "question?", "options": ["A","B","C","D"] },\n` +
      `    { "id": "q2", "text": "question?", "options": ["A","B","C","D"] },\n` +
      `    { "id": "q3", "text": "question?", "options": ["A","B","C","D"] }\n` +
      `  ]\n` +
      `}`,
  }], 600, userId, 'group_onboarding_questions');

  return parseJson(text);
};

// ── Phase 2 — Project Definition + Milestones (Opus) ─────────────────────────
// Takes the owner's clarifying answers and produces purpose + milestone list.
const generateGroupDefinition = async ({ groupName, answers, userId }) => {
  const answersText = answers.map((a, i) => `Q${i + 1}: ${a}`).join('\n');

  const text = await callModel(THEONES_MODEL, [{
    role: 'user',
    content:
      `You are TheOnes, the intelligence layer of Gonya.\n\n` +
      `Group name: "${groupName}"\n` +
      `Owner's answers:\n${answersText}\n\n` +
      `Based on this context, define the group's project profile.\n\n` +
      `Respond ONLY with valid JSON:\n` +
      `{\n` +
      `  "purpose": "1-2 sentence description of what this group is collectively working on",\n` +
      `  "milestones": [\n` +
      `    { "label": "short milestone name", "description": "1 sentence", "order": 1 },\n` +
      `    { "label": "short milestone name", "description": "1 sentence", "order": 2 },\n` +
      `    { "label": "short milestone name", "description": "1 sentence", "order": 3 }\n` +
      `  ]\n` +
      `}\n\n` +
      `Rules: purpose must be specific to their answers, not generic. ` +
      `Milestones should reflect a realistic progression toward their stated goal. ` +
      `3 milestones minimum, 5 maximum.`,
  }], 1000, userId, 'group_onboarding_definition');

  return parseJson(text);
};

// ── Phase 3 — Team Context (Haiku, each member's role) ───────────────────────
// Quick pass over the member list — Haiku is enough for this, no deep
// reasoning needed, just structuring who's who.
const generateTeamContext = async ({ groupName, purpose, members, userId }) => {
  const memberList = members.map(m => `${m.display_name} (${m.role})`).join(', ');

  const text = await callModel(HAIKU_MODEL, [{
    role: 'user',
    content:
      `You are TheOnes, the intelligence layer of Gonya.\n\n` +
      `Group: "${groupName}"\n` +
      `Purpose: ${purpose}\n` +
      `Members: ${memberList}\n\n` +
      `Write a brief team context description (2-3 sentences) noting the composition ` +
      `of the team and how their roles relate to the group's purpose.\n\n` +
      `Respond ONLY with valid JSON:\n` +
      `{ "team_context": "..." }`,
  }], 400, userId, 'group_onboarding_team');

  return parseJson(text);
};

// ── Phase 4 — Agent Configuration (Opus) ─────────────────────────────────────
// The highest-stakes phase — Opus decides how Aksel and Vera should behave
// specifically for this group's purpose and team composition.
const generateAgentConfig = async ({ groupName, purpose, milestones, teamContext, userId }) => {
  const milestoneList = milestones.map(m => `${m.order}. ${m.label}: ${m.description}`).join('\n');

  const text = await callModel(THEONES_MODEL, [{
    role: 'user',
    content:
      `You are TheOnes, the intelligence layer of Gonya.\n\n` +
      `Group: "${groupName}"\n` +
      `Purpose: ${purpose}\n` +
      `Milestones:\n${milestoneList}\n` +
      `Team: ${teamContext}\n\n` +
      `Configure how Aksel (COO/execution, Groq/Llama) and Vera (research/depth, Claude Sonnet) ` +
      `should serve this specific group. Both agents read the group chat and Aksel decides ` +
      `whether to respond, stay silent, or hand off to Vera.\n\n` +
      `Respond ONLY with valid JSON:\n` +
      `{\n` +
      `  "aksel_focus": "what Aksel prioritizes for this group (1-2 sentences)",\n` +
      `  "vera_focus": "what Vera prioritizes for this group (1-2 sentences)",\n` +
      `  "aksel_triggers": ["situation that warrants Aksel responding", "..."],\n` +
      `  "vera_triggers": ["situation that warrants Vera being called in", "..."],\n` +
      `  "collaboration_note": "how the two agents should hand off to each other here"\n` +
      `}\n\n` +
      `Rules: triggers must be specific to this group's domain, not generic. ` +
      `2-3 triggers each. collaboration_note max 1 sentence.`,
  }], 800, userId, 'group_onboarding_agent_config');

  return parseJson(text);
};

// ── Main entry point — run all 4 phases and persist result ───────────────────
const runGroupOnboarding = async ({ groupId, groupName, answers, members, userId }) => {
  console.log(`[TheOnes:Group] Starting onboarding for group "${groupName}" (${groupId})`);

  try {
    // Phase 2: Project definition + milestones
    const definition = await generateGroupDefinition({ groupName, answers, userId });
    console.log(`[TheOnes:Group] Phase 2 complete — purpose defined`);

    // Phase 3: Team context
    const teamResult = await generateTeamContext({
      groupName,
      purpose: definition.purpose,
      members,
      userId,
    });
    console.log(`[TheOnes:Group] Phase 3 complete — team context built`);

    // Phase 4: Agent config
    const agentConfig = await generateAgentConfig({
      groupName,
      purpose:     definition.purpose,
      milestones:  definition.milestones,
      teamContext: teamResult.team_context,
      userId,
    });
    console.log(`[TheOnes:Group] Phase 4 complete — agent config ready`);

    // Persist everything to the groups table
    const { error } = await supabase
      .from('groups')
      .update({
        purpose:        definition.purpose,
        milestones:     definition.milestones,
        agent_config:   { ...agentConfig, team_context: teamResult.team_context },
        onboarding_done: true,
        updated_at:     new Date().toISOString(),
      })
      .eq('id', groupId);

    if (error) throw error;

    console.log(`[TheOnes:Group] Onboarding complete for group ${groupId}`);
    return {
      status:       'success',
      purpose:      definition.purpose,
      milestones:   definition.milestones,
      agent_config: agentConfig,
    };

  } catch (err) {
    console.error(`[TheOnes:Group] Onboarding error:`, err.message);
    return { status: 'error', message: err.message };
  }
};

module.exports = { generateGroupQuestions, runGroupOnboarding };