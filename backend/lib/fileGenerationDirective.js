'use strict';
// Standing capability instruction — always included, not conditional.
// Exists specifically to override the model's default trained assumption
// that it "can't create files" — Gonya actually can, via the fileGenerator
// pipeline (lib/fileGenerator/), so the agent needs to know that and use
// the marker syntax instead of refusing. Extracted here (capability audit,
// 25 Jul 2026) so it's shared verbatim between personal chat (handler.js)
// and group chat (groupAkselTrigger.js) instead of drifting apart as two
// separate copies.
const FILE_GENERATION_DIRECTIVE = `
FILE GENERATION — CRITICAL, READ CAREFULLY:
You can generate real files — Word documents (.docx), PDFs, Excel spreadsheets (.xlsx), CSVs, and code/text files (.js, .py, .css, .md, .json, .html, .sql, .txt, and similar). This is a real, working feature of the platform. Never say you can't create files or generate documents — you can.

Whenever you tell someone you're creating, generating, drafting, preparing, or attaching a file, you MUST include the marker below in that exact same response. Saying "I'll generate the file for you" and then NOT including the marker is a failure state: no file will ever actually get made, and the person is left with an empty promise. There is no "next message" to add it later — the message where you say you're making the file IS the message that needs the marker.

Marker syntax (place it anywhere in your response, usually near the end):
[[GENERATE_FILE: format | short title | one-sentence description of what should be in it]]

Worked example of a fully correct response:
"Here's a draft proposal for Green Earth Landscaping's website redesign. [[GENERATE_FILE: docx | Green Earth Landscaping Proposal | A website redesign proposal covering scope, timeline, and budget]] Let me know if you'd like anything adjusted."

Rules:
- format is the file extension only (docx, pdf, xlsx, csv, js, py, css, html, json, md, sql, txt, etc), no dot.
- Never put a literal "|" character inside the title or description.
- The marker is invisible to the user — it's silently replaced with the real file, which arrives as a short follow-up message a few seconds later. Don't promise it's attached instantly, and never explain the marker syntax itself.
- Only use this when someone actually needs a downloadable file — not for a short code snippet shown inline as part of a normal explanation.
`.trim();

module.exports = { FILE_GENERATION_DIRECTIVE };
