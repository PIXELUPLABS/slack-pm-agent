import { tool } from '@anthropic-ai/claude-agent-sdk';

import { loadGuidelinesTemplate } from '../../config/index.js';

/**
 * Template read tools. The engagement-guidelines template lives in
 * config/engagement-guidelines-template.md (versioned house terms and
 * boilerplate) and is served through a tool rather than baked into the system
 * prompt, so its ~1.5k tokens only enter the context on the turns that
 * actually draft guidelines.
 * @returns {any[]}
 */
export function createTemplateTools() {
  return [
    tool(
      'read_engagement_guidelines_template',
      'The house engagement-guidelines template (Markdown). Call it when drafting engagement guidelines v1 from a ' +
        'project scope. Fill the [TBD: …] slots ONLY with facts the scope states; leave the slot in place (with a ' +
        'note on what is needed) when the scope is silent. Text outside the slots is house standard — keep it.',
      {},
      async () => {
        try {
          return { content: [{ type: 'text', text: loadGuidelinesTemplate() }] };
        } catch (e) {
          return {
            content: [{ type: 'text', text: `Template unavailable: ${/** @type {Error} */ (e).message}` }],
          };
        }
      },
    ),
  ];
}
