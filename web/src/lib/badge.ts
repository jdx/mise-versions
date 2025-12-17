// Badge utilities for generating SVG download badges

// Format number for badge display
export function formatCount(count: number): string {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return count.toString();
}

// Calculate text width (approximate, based on character count)
// Using a simple heuristic: average character width is ~7px for 11px font
function measureText(text: string, fontSize: number = 11): number {
  const charWidth = fontSize * 0.6;
  return Math.ceil(text.length * charWidth);
}

// Escape XML special characters
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Generate shields.io-style SVG badge
export function generateBadgeSvg(
  label: string,
  value: string,
  labelColor: string = '#555',
  valueColor: string = '#4c1'
): string {
  const padding = 10;
  const labelWidth = measureText(label) + padding * 2;
  const valueWidth = measureText(value) + padding * 2;
  const totalWidth = labelWidth + valueWidth;
  const height = 20;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}">
  <linearGradient id="smooth" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="round">
    <rect width="${totalWidth}" height="${height}" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#round)">
    <rect width="${labelWidth}" height="${height}" fill="${labelColor}"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="${height}" fill="${valueColor}"/>
    <rect width="${totalWidth}" height="${height}" fill="url(#smooth)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>
    <text x="${labelWidth / 2}" y="14" fill="#fff">${escapeXml(label)}</text>
    <text x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(value)}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14" fill="#fff">${escapeXml(value)}</text>
  </g>
</svg>`;
}

// SVG response helper
export function svgResponse(svg: string, cacheSeconds: number = 3600): Response {
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': `public, max-age=${cacheSeconds}, stale-while-revalidate=86400`,
      'Access-Control-Allow-Origin': '*',
    },
  });
}
