'use strict';
const express = require('express');
const router  = express.Router();
const { verifyToken }               = require('../middleware/auth');
const { runOnboarding, runEvolution } = require('../theones/orchestrator');
const { generateQuestions }         = require('../theones/generator');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// POST /api/theones/verify-token
router.post('/verify-token', verifyToken, async (req, res) => {
  const { tokenCode } = req.body;
  
  if (!tokenCode) {
    return res.status(400).json({ status: 'error', message: 'Token is required.' });
  }

  try {
    const { data: tokenData, error: fetchErr } = await supabase
      .from('guest_access_tokens')
      .select('*')
      .eq('token', tokenCode)
      .single();

    if (fetchErr || !tokenData) {
      return res.status(404).json({ status: 'error', message: 'Invalid or expired token code.' });
    }

    if (tokenData.assigned_user_id && tokenData.assigned_user_id !== req.userId) {
      return res.status(403).json({ status: 'error', message: 'This token is tied to a different account.' });
    }

    if (tokenData.personal_onboard_used) {
      return res.status(403).json({ status: 'error', message: 'This token has already been used.' });
    }

    const { error: updateErr } = await supabase
      .from('guest_access_tokens')
      .update({
         personal_onboard_used: true
      })
      .eq('id', tokenData.id);

    if (updateErr) throw updateErr;

    res.json({ status: 'success', message: 'Token access claimed successfully.' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ status: 'error', message: 'Internal server error.' });
  }
});

// POST /api/theones/questions
router.post('/questions', verifyToken, async (req, res) => {
  const { domain, gender, language_style } = req.body;

  if (!domain?.trim()) {
    return res.status(400).json({ status: 'error', message: 'Domain is required' });
  }

  try {
    const result = await generateQuestions({
      domain:        domain.trim(),
      gender:        gender || 'male',
      languageStyle: language_style || 'casual',
    });

    res.json({ status: 'success', ...result });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /api/theones/onboard
router.post('/onboard', verifyToken, async (req, res) => {
  const { domain, gender, language_style, taxonomy_path, clarifying_answers } = req.body;

  if (!domain?.trim()) {
    return res.status(400).json({ status: 'error', message: 'Domain is required' });
  }
  if (!gender || !['male', 'female'].includes(gender)) {
    return res.status(400).json({ status: 'error', message: 'Gender must be male or female' });
  }
  if (!language_style || !['casual', 'formal'].includes(language_style)) {
    return res.status(400).json({ status: 'error', message: 'language_style must be casual or formal' });
  }

  try {
    const result = await runOnboarding({
      userId:           req.userId,
      domain:           domain.trim(),
      gender,
      languageStyle:    language_style,
      taxonomyPath:     taxonomy_path  || null,
      clarifyingAnswers: clarifying_answers || null,
    });

    res.json(result);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── General (demo) persona — assigned directly, no TheOnes/Opus call ──
// Bug fixed/designed (9 Sep 2026): running the real Opus-driven onboarding
// for every casual demo visitor would mean real, uncontrolled cost per
// visit with no client behind it yet. This gives every demo user the
// FULL real product experience — same two agents, same downstream
// system-prompt pipeline, same everything — just with a pre-written
// persona instead of one generated fresh per visitor. Matches the same
// structural shape TheOnes itself produces (style paragraph, "Lead
// when:", "Never:", "Handoff:") so buildSystemPrompt() and every
// downstream consumer treat this identically to a real generated one.
// Deliberately does NOT bake in gender/language-style-specific phrasing
// the way a real TheOnes-generated persona sometimes does — that's
// already handled dynamically per-turn by buildSystemPrompt()'s own
// LANGUAGE & PRONOUN RULE regardless of what's in persona_prompt, so one
// general text serves every demo user regardless of their own gender/
// language_style choice.
const GENERAL_DOMAIN = 'general life, career, and personal growth';

// Bug fixed (9 Sep 2026): initial draft leaned right back into the
// "structured playbook" / consultant-report voice this whole project has
// repeatedly had to fix Aksel out of elsewhere (see chat/handler.js's
// avoid_markdown_in_chat and multi-round attempts to soften his tone).
// Rewritten after researching persona-prompting best practices — the
// core lesson: concrete behavioral habits and genuine opinions read as
// a real personality; abstract trait-adjectives ("direct", "structured")
// read as a job description. Both personas below lead with how they
// actually TALK, not what framework they follow.
const GENERAL_PERSONA_AKSEL =
`Aksel talks like someone who's actually been in the trenches, not someone presenting a plan. He doesn't open with frameworks — he reacts first, like a friend would ("okay, so here's the thing..."), and only gets structured if the situation genuinely calls for it. He's got zero patience for someone stalling on a decision they've already basically made, and he'll say so directly rather than dressing it up. He remembers what someone told him earlier in the conversation and calls back to it ("didn't you just say X? that kind of answers this"). He's comfortable being wrong or changing his mind out loud, rather than defending a take just because he said it first.

Lead when: Someone's clearly stalling on something they already know the answer to; Someone's choosing between real options and just needs a second, blunter opinion; The conversation's been going in circles and needs a plain "here's what I'd actually do."

Never: Jump straight to a structured plan before actually reacting to what the person said like a person would; Manufacture urgency nobody asked for; Push a big, hard-to-undo decision without Vera weighing in first; Pretend to know details about someone's life they haven't actually shared.

Handoff: Vera goes first when someone needs to actually work through how they feel or what they want. Aksel picks it up once there's something real to act on — and hands it right back if it turns out the "practical" question was actually about something else.`;

const GENERAL_PERSONA_VERA =
`Vera actually sits with what someone says before responding — she'll ask a real follow-up instead of jumping to advice, and she's not afraid of a pause in the conversation. She notices when someone's answer doesn't quite match their tone, and she'll gently point that out rather than taking the words at face value. She has her own read on things and will say when she disagrees, but she won't manufacture a crisis where the person didn't bring one. She's warm without being soft — she can hold someone accountable to something they said earlier without it feeling like a lecture.

Lead when: Someone's clearly processing a feeling, not asking for a solution yet; What someone's saying and how they're saying it don't quite match; Someone opens up about something and just needs to be heard before anything gets "solved."

Never: Rush past a real feeling to get to a plan; Push a big, hard-to-undo decision without making sure it's actually been thought through; Pretend to know details about someone's life they haven't actually shared.

Handoff: Vera hands off once someone has real clarity and is ready to act — not before. Aksel hands back whenever what looked like a practical question turns out to be about something Vera should actually dig into.`;

// POST /api/theones/onboard-demo
router.post('/onboard-demo', verifyToken, async (req, res) => {
  const { gender } = req.body;

  if (!gender || !['male', 'female'].includes(gender)) {
    return res.status(400).json({ status: 'error', message: 'Gender must be male or female' });
  }

  try {
    const rows = [
      {
        user_id:        req.userId,
        agent:          'Aksel',
        domain:         GENERAL_DOMAIN,
        persona_prompt: GENERAL_PERSONA_AKSEL,
        is_dominant:    gender === 'male',
      },
      {
        user_id:        req.userId,
        agent:          'Vera',
        domain:         GENERAL_DOMAIN,
        persona_prompt: GENERAL_PERSONA_VERA,
        is_dominant:    gender === 'female',
      },
    ];

    // Bug fixed (9 Sep 2026): plain .insert() would create duplicate rows
    // if this endpoint is ever called twice for the same user (a double
    // click, a retry after a slow connection) — upsert with the same
    // onConflict key orchestrator.js's real runOnboarding() already uses
    // makes a second call safely overwrite instead of duplicate.
    const { error } = await supabase
      .from('agent_configs')
      .upsert(rows, { onConflict: 'user_id,agent' });
    if (error) throw error;

    res.json({ status: 'success' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /api/theones/evolve
router.post('/evolve', verifyToken, async (req, res) => {
  try {
    const result = await runEvolution({ userId: req.userId });
    res.json(result);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;