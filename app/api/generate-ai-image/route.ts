import { NextRequest, NextResponse } from 'next/server';
import { openai } from '@/lib/openai';
import { toFile } from 'openai';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      screenshotBase64,
      userPrompt,
      conversationHistory = [],
    }: {
      screenshotBase64: string;
      userPrompt: string;
      conversationHistory: { role: 'user' | 'assistant'; content: string }[];
    } = body;

    if (!screenshotBase64 || !userPrompt?.trim()) {
      return NextResponse.json({ error: 'screenshotBase64 and userPrompt are required' }, { status: 400 });
    }

    // Build context from previous prompts (conversation memory)
    const contextNote =
      conversationHistory.filter((m) => m.role === 'user').length > 0
        ? ` Previous variations requested: ${conversationHistory
            .filter((m) => m.role === 'user')
            .slice(-3)
            .map((m) => `"${m.content}"`)
            .join(', ')}. Now create a new variation:`
        : '';

    const fullPrompt =
      `You are an architectural visualization artist. I am showing you a 3D model of a modular building. ` +
      `Your task: generate a photorealistic architectural exterior rendering of EXACTLY this building layout — ` +
      `preserve the exact module count, arrangement, shapes, roof geometry, and spatial composition. ` +
      `Do NOT change the building structure in any way.${contextNote} ` +
      `Environment and atmosphere to apply: ${userPrompt.trim()}. ` +
      `Style: photorealistic architectural rendering, natural perspective, high detail.`;

    // Convert base64 data URL to Buffer → File for gpt-image-1 edit
    const base64Data = screenshotBase64.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');
    const imageFile = await toFile(imageBuffer, 'screenshot.png', { type: 'image/png' });

    // Use gpt-image-1 images.edit — sends the actual screenshot and generates a new image
    const response = await openai.images.edit({
      model: 'gpt-image-1',
      image: imageFile,
      prompt: fullPrompt,
      size: '1024x1024',
    });

    const b64 = response.data?.[0]?.b64_json;
    if (!b64) {
      return NextResponse.json({ error: 'No image generated' }, { status: 500 });
    }

    return NextResponse.json({
      imageUrl: `data:image/png;base64,${b64}`,
      promptUsed: fullPrompt,
    });
  } catch (err: unknown) {
    console.error('[generate-ai-image] error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

