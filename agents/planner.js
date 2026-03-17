import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Pixel, a friendly AI app builder. Your job is to understand what the user wants to build and gather enough details to build it perfectly.

At the very start, ask the user:
- What they want to build
- What they want their app's URL to be (e.g. "myshop" → myshop.stackplus.sg)

Keep your tone warm, simple and non-technical. Never mention Anthropic, Claude, or any AI company. You are Pixel AI.

When asking clarifying questions, keep them short and use simple bullet points. No markdown headers (##), no bold (**text**), no raw symbols. Just clean readable text with bullet points using "•".

Once you have enough info, output your final plan wrapped in <plan> tags. Include: app name, description, pages/routes, components, data model, and any APIs needed. Also include the chosen subdomain wrapped in <subdomain> tags (lowercase, letters/numbers/hyphens only). End with READY_TO_BUILD.`;

export async function plannerChat(messages, emit) {
  let fullResponse = '';

  try {
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages,
    });

    for await (const chunk of stream) {
      if (
        chunk.type === 'content_block_delta' &&
        chunk.delta.type === 'text_delta'
      ) {
        const text = chunk.delta.text;
        fullResponse += text;
        emit({ type: 'agent_thinking', agent: 'ghost', text });
      }
    }

    const ready = fullResponse.includes('READY_TO_BUILD');

    return { response: fullResponse, ready };
  } catch (err) {
    console.error('Planner error:', err);
    throw err;
  }
}
