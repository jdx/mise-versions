import type { APIRoute } from 'astro';
import { ImageResponse } from 'workers-og';

// GET /api/og - Generate OG image for homepage
export const GET: APIRoute = async () => {
  const html = `
    <div style="display: flex; flex-direction: column; width: 100%; height: 100%; background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%); padding: 60px;">
      <div style="display: flex; flex-direction: column; flex: 1; justify-content: center;">
        <div style="display: flex; align-items: center; margin-bottom: 24px;">
          <span style="font-size: 72px; font-weight: 800; background: linear-gradient(90deg, #B026FF, #FF2D95); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">mise tools</span>
        </div>
        <p style="font-size: 32px; color: #9ca3af; margin: 0; line-height: 1.4;">
          Browse tool versions and download stats for mise
        </p>
        <p style="font-size: 24px; color: #6b7280; margin-top: 24px;">
          960+ tools available
        </p>
      </div>
      <div style="display: flex; align-items: center; gap: 12px;">
        <span style="font-size: 20px; color: #6b7280;">mise-tools.jdx.dev</span>
      </div>
    </div>
  `;

  return new ImageResponse(html, {
    width: 1200,
    height: 630,
  });
};
