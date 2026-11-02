'use strict';
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('[Anthropic] Missing ANTHROPIC_API_KEY in .env');
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

module.exports = { anthropic };