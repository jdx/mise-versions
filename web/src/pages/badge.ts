import type { APIRoute } from "astro";
import { generateBadgeSvg, svgResponse } from "../lib/badge";

// GET /badge - General "mise-en-place" badge
export const GET: APIRoute = async () => {
  const svg = generateBadgeSvg("mise", "en place", "#1c1614", "#7c4dff");
  return svgResponse(svg, 86400); // Cache for 24 hours (static badge)
};
