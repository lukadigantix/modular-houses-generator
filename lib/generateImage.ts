export type ImageSize = '1024x1024' | '1792x1024' | '1024x1792';
export type ImageQuality = 'standard' | 'hd';

export interface GenerateImageParams {
  prompt: string;
  size?: ImageSize;
  quality?: ImageQuality;
}

export interface GenerateImageResult {
  images: { url: string; revised_prompt?: string }[];
}

export async function generateImage(params: GenerateImageParams): Promise<GenerateImageResult> {
  const res = await fetch('/api/generate-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Failed to generate image');
  }

  return res.json();
}
