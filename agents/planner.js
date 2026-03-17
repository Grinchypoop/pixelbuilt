import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Pixel's planning agent. Your job is to understand what the user wants to build and create a detailed technical plan. Ask clarifying questions if needed. When you have enough information, output your final plan wrapped in <plan> tags. The plan should include: app name, description, pages/routes, components, data model, and any APIs needed. Once you output the plan, end with READY_TO_BUILD.`;

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
        emit({ type: 'agent_thinking', agent: 'planner', text });
      }
    }

    const ready = fullResponse.includes('READY_TO_BUILD');

    return { response: fullResponse, ready };
  } catch (err) {
    console.error('Planner error:', err);
    throw err;
  }
}
