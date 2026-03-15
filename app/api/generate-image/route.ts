import { NextRequest, NextResponse } from 'next/server';
import { openai } from '@/lib/openai';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { prompt, size = '1792x1024', quality = 'standard', n = 1 } = body;

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }

    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt: prompt.trim(),
      n,
      size,
      quality,
      response_format: 'url',
    });

    const images = (response.data ?? []).map((img) => ({
      url: img.url,
      revised_prompt: img.revised_prompt,
    }));

    return NextResponse.json({ images });
  } catch (err: unknown) {
    console.error('[generate-image] error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
