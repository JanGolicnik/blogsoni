import sizeOf from "buffer-image-size";
import { Vibrant } from "node-vibrant/node";

const FAVICON_SIZE = 64; // must exceed 16 for the globe check to discriminate

// sRGB byte -> linear light. LUT beats pow() per call.
const _lin = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  _lin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Perceptual chroma. Hue-uniform, unlike HSV/HSL saturation: a muted brown
// scores low here even though HSL would call it saturated.
function oklab_chroma(r, g, b) {
  const lr = _lin[r], lg = _lin[g], lb = _lin[b];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return Math.hypot(A, B);
}

const C_MIN = 0.02; // below this the icon is effectively greyscale

// "h s% l%" — drops straight into hsl().
function RGBtoHSL(r, g, b) {
  r /= 255; g /= 255; b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;

  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }

  return `${h.toFixed(1)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%`;
}

async function get_top_color(buffer) {
  const palette = await Vibrant.from(buffer).quality(1).getPalette();

  let best = null;
  let best_score = -1;

  for (const swatch of Object.values(palette)) {
    if (!swatch) continue;
    const [r, g, b] = swatch.rgb;

    // log1p on population keeps area as a tiebreaker without letting a large
    // flat background dominate; chroma stays linear and drives the decision.
    const score = oklab_chroma(r, g, b) * Math.log1p(swatch.population);

    if (score > best_score) {
      best_score = score;
      best = swatch;
    }
  }

  if (!best) return null;
  if (oklab_chroma(...best.rgb) < C_MIN) return null;

  return best.rgb;
}

export async function fetch_favicon(url) {
  try {
    const hostname = new URL(url).hostname;
    const res = await fetch(
      `https://www.google.com/s2/favicons?sz=${FAVICON_SIZE}&domain=${hostname}`,
      { headers: { "User-Agent": "blogson/1.0 (jan@nejka.net)" } },
    );
    if (!res.ok) return null;

    const favicon_mime = res.headers.get("content-type") ?? "image/png";
    if (!favicon_mime.startsWith("image/")) return null;

    const favicon_data = Buffer.from(await res.arrayBuffer());
    if (favicon_data.length === 0) return null;

    // Google's default globe is always 16x16 regardless of the requested size.
    // sizeOf throws on unrecognised data, so treat a failure as "not the globe".
    let dim = null;
    try {
      dim = sizeOf(favicon_data);
    } catch {}
    if (dim && dim.width <= 16 && dim.height <= 16) return null;

    const rgb = await get_top_color(favicon_data);
    if (!rgb) return null;

    return {
      favicon_mime,
      favicon_data,
      favicon_color1: RGBtoHSL(...rgb),
    };
  } catch (e) {
    console.log(e);
    return null;
  }
}
