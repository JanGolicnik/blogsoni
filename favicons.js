import UPNG from "upng-js";

// https://stackoverflow.com/questions/17242144/how-to-convert-hsb-hsv-color-to-rgb-accurately
function HSVtoRGB(h, s, v) {
  var r, g, b, i, f, p, q, t;
  i = Math.floor(h * 6);
  f = h * 6 - i;
  p = v * (1 - s);
  q = v * (1 - f * s);
  t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0:
      ((r = v), (g = t), (b = p));
      break;
    case 1:
      ((r = q), (g = v), (b = p));
      break;
    case 2:
      ((r = p), (g = v), (b = t));
      break;
    case 3:
      ((r = p), (g = q), (b = v));
      break;
    case 4:
      ((r = t), (g = p), (b = v));
      break;
    case 5:
      ((r = v), (g = p), (b = q));
      break;
  }
  return { r: r * 255, g: g * 255, b: b * 255 };
}

function RGBtoHSV(r, g, b) {
  var max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min,
    h,
    s = max === 0 ? 0 : d / max,
    v = max;

  switch (max) {
    case min:
      h = 0;
      break;
    case r:
      h = g - b + d * (g < b ? 6 : 0);
      h /= 6 * d;
      break;
    case g:
      h = b - r + d * 2;
      h /= 6 * d;
      break;
    case b:
      h = r - g + d * 4;
      h /= 6 * d;
      break;
  }

  return { h, s, v };
}

const fix_color = (c) => {
  let hsv = RGBtoHSV(c.r, c.g, c.b);
  const rgb = HSVtoRGB(hsv.h, Math.max(hsv.s, 0.25), Math.max(hsv.v, 0.55));
  return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
};

function get_top_colors(data, w, h) {
  let buckets = {};
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i + 0];
    let g = data[i + 1];
    let b = data[i + 2];
    let a = data[i + 3];
    if (a < 128) continue;

    let brightness = r * 0.2126 + g * 0.7152 + b * 0.0722;
    if (brightness < 30) continue;

    r = Math.floor(r / 32) * 32;
    g = Math.floor(g / 32) * 32;
    b = Math.floor(b / 32) * 32;
    let key = r + "," + g + "," + b;
    if (!buckets[key]) buckets[key] = { r, g, b, count: 0 };
    buckets[key].count++;
  }

  let sorted = Object.values(buckets).sort((a, b) => {
    return b.count - a.count;
  });
  if (sorted.length === 0) return null;

  const c1 = sorted[0];
  const c2 = sorted.length > 1 ? sorted[1] : sorted[0];
  return {
    color1: fix_color({
      r: c1.r / 255.0,
      g: c1.g / 255.0,
      b: c1.b / 255.0,
    }),
    color2: fix_color({
      r: c2.r / 255.0,
      g: c2.g / 255.0,
      b: c2.b / 255.0,
    }),
  };
}

export async function fetch_favicon(url) {
  try {
    const origin = new URL(url).origin;
    const domain = `https://www.google.com/s2/favicons?sz=32&domain=${origin}`;
    const res = await fetch(domain, {
      headers: { "User-Agent": "blogson/1.0 (jan@nejka.net)" },
    });
    const favicon_mime = res.headers.get("Content-Type", "image/png");
    if (!favicon_mime.startsWith("image/")) return null;
    const favicon_data = Buffer.from(await res.arrayBuffer());
    const colors = get_top_colors(
      new Uint8Array(UPNG.toRGBA8(UPNG.decode(favicon_data))[0]),
    );
    return {
      favicon_mime,
      favicon_data,
      favicon_color1: colors.color1,
      favicon_color2: colors.color2,
    };
  } catch (e) {
    console.log(e);
    return null;
  }
}
