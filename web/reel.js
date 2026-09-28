// The full-screen intro: a ~16-second reel drawn on one canvas, in the
// logo's colours. The room draws itself, gets scanned, develops into a photo, then is
// furnished and restyled by voice. It plays once, then fades away to reveal the landing page.
// Every frame is a pure function of time, so skipping or replaying is trivial.

(() => {
  const intro = document.getElementById('intro');
  const canvas = document.getElementById('reel');
  if (!intro || !canvas) return;
  const ctx = canvas.getContext('2d');

  // Taken from logo.png: cyan → blue → violet on near-black, white type.
  const C = {
    cyan: '#22d3ee',
    blue: '#3b5bff',
    violet: '#a855f7',
    black: '#05060a',
    white: '#f4f6ff',
    mist: '#e9ecff',
    amber: '#ffc457',
  };
  const STOPS = [
    [0x22, 0xd3, 0xee],
    [0x3b, 0x5b, 0xff],
    [0xa8, 0x55, 0xf7],
  ];
  const DISPLAY = '"Archivo Black", "Arial Black", sans-serif';
  const SERIF = '"Instrument Serif", Georgia, serif';
  const MONO = '"JetBrains Mono", ui-monospace, monospace';

  /* ---------------------------------------------------------------- */
  /* Easing, timing and colour helpers                                 */
  /* ---------------------------------------------------------------- */

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const seg = (t, a, b) => clamp((t - a) / (b - a));
  const lerp = (a, b, p) => a + (b - a) * p;
  const E = {
    cubic: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    outExpo: (p) => (p === 1 ? 1 : 1 - Math.pow(2, -10 * p)),
    outBack: (p) => (p <= 0 ? 0 : p >= 1 ? 1 : 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2)),
    outCubic: (p) => 1 - Math.pow(1 - p, 3),
  };

  // A colour from the logo gradient, p in [0, 1].
  function brand(p, alpha = 1) {
    p = clamp(p) * 2;
    const i = Math.min(1, Math.floor(p));
    const f = p - i;
    const [a, b] = [STOPS[i], STOPS[i + 1]];
    const rgb = a.map((v, k) => Math.round(lerp(v, b[k], f))).join(',');
    return alpha === 1 ? `rgb(${rgb})` : `rgba(${rgb},${alpha})`;
  }

  function brandGradient(x0, y0, x1, y1) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, C.cyan);
    g.addColorStop(0.55, C.blue);
    g.addColorStop(1, C.violet);
    return g;
  }

  let W = 0;
  let H = 0;
  let u = 1; // layout unit: 1/100 of the height, capped for portrait screens

  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width;
    H = r.height;
    u = Math.min(H / 100, W / 120);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---------------------------------------------------------------- */
  /* Drawing primitives                                                */
  /* ---------------------------------------------------------------- */

  function fill(style) {
    ctx.fillStyle = style;
    ctx.fillRect(0, 0, W, H);
  }

  function circle(x, y, r, style) {
    if (r <= 0) return;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = style;
    ctx.fill();
  }

  function poly(pts, fillStyle, stroke, lw = 1) {
    ctx.beginPath();
    ctx.moveTo(...pts[0]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(...pts[i]);
    ctx.closePath();
    if (fillStyle) {
      ctx.fillStyle = fillStyle;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }

  function glow(color, blur, draw) {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    draw();
    ctx.restore();
  }

  function text(str, x, y, { font, size, color, align = 'center', base = 'middle', alpha = 1 }) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    // CSS font shorthand wants the style before the size: "italic 40px Serif".
    const italic = font.startsWith('italic ');
    ctx.font = `${italic ? 'italic ' : ''}${size}px ${italic ? font.slice(7) : font}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = base;
    ctx.fillText(str, x, y);
    ctx.restore();
  }

  // Big display word whose letters rise out of a mask, one after another.
  function riseWord(word, cx, cy, size, color, lt, { stagger = 0.06, dur = 0.5, delay = 0, font = DISPLAY } = {}) {
    ctx.save();
    ctx.font = `${size}px ${font}`;
    const widths = [...word].map((ch) => ctx.measureText(ch).width);
    const total = widths.reduce((a, b) => a + b, 0);
    ctx.beginPath();
    ctx.rect(0, cy - size * 0.62, W, size * 1.1);
    ctx.clip();
    let x = cx - total / 2;
    [...word].forEach((ch, i) => {
      const p = E.outExpo(seg(lt, delay + i * stagger, delay + i * stagger + dur));
      ctx.fillStyle = color;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(ch, x, cy + (1 - p) * size * 1.05);
      x += widths[i];
    });
    ctx.restore();
    return total;
  }

  // A spoken line, word by word, in the serif.
  function speak(line, x, y, size, color, lt, { start = 0, per = 0.1, align = 'center' } = {}) {
    const words = line.split(' ');
    ctx.save();
    ctx.font = `italic ${size}px ${SERIF}`;
    const full = ctx.measureText(line).width;
    let cx = align === 'center' ? x - full / 2 : x;
    words.forEach((w, i) => {
      const p = E.outCubic(seg(lt, start + i * per, start + i * per + 0.35));
      const ww = ctx.measureText(`${w} `).width;
      ctx.globalAlpha = p;
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(w, cx, y + (1 - p) * size * 0.3);
      cx += ww;
    });
    ctx.restore();
  }

  // A live voice waveform.
  function waveform(cx, cy, lt, level, bars = 13) {
    const gap = 1.1 * u;
    for (let i = 0; i < bars; i++) {
      const k = i - (bars - 1) / 2;
      const hgt = (0.6 + Math.abs(Math.sin(lt * 11 + i * 1.7)) * 2.6 * (1 - Math.abs(k) / bars)) * u * level;
      ctx.fillStyle = brand(i / (bars - 1));
      const x = cx + k * gap - 0.3 * u;
      ctx.fillRect(x, cy - hgt, 0.6 * u, hgt * 2);
    }
  }

  // Isometric cube: the Dex mark.
  function cube(cx, cy, s, top, right, left, stroke) {
    const v = (k) => {
      const a = (-90 + 60 * k) * (Math.PI / 180);
      return [cx + s * Math.cos(a), cy + s * Math.sin(a)];
    };
    poly([[cx, cy], v(5), v(0), v(1)], top, stroke, Math.max(1, s * 0.03));
    poly([[cx, cy], v(1), v(2), v(3)], right, stroke, Math.max(1, s * 0.03));
    poly([[cx, cy], v(3), v(4), v(5)], left, stroke, Math.max(1, s * 0.03));
  }

  // Corner brackets, as in the logo.
  function brackets(cx, cy, half, len, width, style) {
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [dx, dy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      const x = cx + dx * half;
      const y = cy + dy * half;
      ctx.beginPath();
      ctx.moveTo(x, y - dy * len);
      ctx.lineTo(x, y);
      ctx.lineTo(x - dx * len, y);
      ctx.stroke();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Rendered room photos (same camera, so they dissolve into each other) */
  /* ---------------------------------------------------------------- */

  const PHOTOS = {};
  const photosReady = Promise.all(
    ['empty', 'sofa', 'full', 'warm'].map(
      (k) =>
        new Promise((res) => {
          const img = new Image();
          img.onload = img.onerror = res;
          img.src = `img/room-${k}.jpg`;
          PHOTOS[k] = img;
        }),
    ),
  );

  // Cover-fit a photo with a slow push-in; returns a mapper from image-normalised coords to screen.
  function photo(key, zoom = 1, alpha = 1) {
    const img = PHOTOS[key];
    if (!img || !img.naturalWidth) return (nx, ny) => [nx * W, ny * H];
    const s = Math.max(W / img.naturalWidth, H / img.naturalHeight) * zoom;
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    const x = (W - w) / 2;
    const y = (H - h) / 2;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
    return (nx, ny) => [x + nx * w, y + ny * h];
  }

  // Where an image-normalised point lands on screen, without drawing.
  function photoPoint(key, zoom, nx, ny) {
    const img = PHOTOS[key];
    if (!img || !img.naturalWidth) return [nx * W, ny * H];
    const s = Math.max(W / img.naturalWidth, H / img.naturalHeight) * zoom;
    return [W / 2 + (nx - 0.5) * img.naturalWidth * s, H / 2 + (ny - 0.5) * img.naturalHeight * s];
  }

  // Darken the top of the frame so spoken captions stay legible over the photo.
  function captionShade(strength = 0.75) {
    const g = ctx.createLinearGradient(0, 0, 0, H * 0.45);
    g.addColorStop(0, `rgba(5,6,10,${strength})`);
    g.addColorStop(1, 'rgba(5,6,10,0)');
    fill(g);
    const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
    v.addColorStop(0, 'rgba(5,6,10,0)');
    v.addColorStop(1, 'rgba(5,6,10,.55)');
    fill(v);
  }

  // A glowing scan line that reveals `next` over `prev` from top to bottom.
  function scanReveal(prev, next, p, zoom) {
    photo(prev, zoom);
    if (p <= 0) return;
    const y = H * E.cubic(p);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, y);
    ctx.clip();
    photo(next, zoom);
    ctx.restore();
    if (p < 1) {
      const band = ctx.createLinearGradient(0, y - 10 * u, 0, y);
      band.addColorStop(0, brand(0.2, 0));
      band.addColorStop(1, brand(0.2, 0.35));
      ctx.fillStyle = band;
      ctx.fillRect(0, y - 10 * u, W, 10 * u);
      glow(C.cyan, 3 * u, () => {
        ctx.fillStyle = brandGradient(0, 0, W, 0);
        ctx.fillRect(0, y - 0.2 * u, W, 0.4 * u);
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* The room as a technical drawing, projected with the render camera */
  /* ---------------------------------------------------------------- */

  // Same camera three.js used for img/room-*.jpg (1920 × 1200), so lines land on the photo exactly.
  const CAM = { pos: [4.6, 1.7, 5.4], look: [1.8, 0.75, 1.2], fov: 40, aspect: 1920 / 1200 };
  const REVEAL_ZOOM = 1.02; // the zoom POINT opens on, so the hand-off is frame-exact
  const basis = (() => {
    const sub = (a, b) => a.map((v, i) => v - b[i]);
    const norm = (a) => a.map((v) => v / Math.hypot(...a));
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const f = norm(sub(CAM.look, CAM.pos));
    const r = norm(cross(f, [0, 1, 0]));
    return { f, r, up: cross(r, f), tan: Math.tan((CAM.fov * Math.PI) / 360) };
  })();

  function project([x, y, z], zoom = REVEAL_ZOOM) {
    const d = [x - CAM.pos[0], y - CAM.pos[1], z - CAM.pos[2]];
    const dot = (a) => a[0] * d[0] + a[1] * d[1] + a[2] * d[2];
    const cz = dot(basis.f);
    const nx = 0.5 + dot(basis.r) / (cz * basis.tan * CAM.aspect) / 2;
    const ny = 0.5 - dot(basis.up) / (cz * basis.tan) / 2;
    const s = Math.max(W / 1920, H / 1200) * zoom;
    return [W / 2 + (nx - 0.5) * 1920 * s, H / 2 + (ny - 0.5) * 1200 * s];
  }

  // Room edges (metres): the wall corner, both floor lines, the window.
  const EDGES = [
    [[0, 0, 0], [0, 3.2, 0]],
    [[0, 0, 0], [7, 0, 0]],
    [[0, 0, 0], [0, 0, 7]],
    [[2.3, 0.85, 0], [3.7, 0.85, 0]],
    [[3.7, 0.85, 0], [3.7, 2.2, 0]],
    [[3.7, 2.2, 0], [2.3, 2.2, 0]],
    [[2.3, 2.2, 0], [2.3, 0.85, 0]],
  ];
  // Dimension callouts: from, to, label, which side of the line the label sits (+1 = below).
  const DIMS = [
    [[0, 0, 0.35], [4.2, 0, 0.35], '4.20 m', 1],
    [[0.35, 0, 0], [0.35, 0, 3.4], '3.40 m', 1],
    [[2.3, 0.6, 0], [3.7, 0.6, 0], '1.40 m', 1],
  ];
  // LiDAR samples on the floor and both walls, ordered left to right for the sweep.
  const SAMPLES = (() => {
    const pts = [];
    for (let x = 0.1; x < 6.5; x += 0.22) for (let z = 0.1; z < 6.5; z += 0.22) pts.push([x, 0, z]);
    for (let x = 0.1; x < 6.5; x += 0.22) for (let y = 0.1; y < 3.2; y += 0.22) pts.push([x, y, 0]);
    for (let z = 0.1; z < 6.5; z += 0.22) for (let y = 0.1; y < 3.2; y += 0.22) pts.push([0, y, z]);
    return pts;
  })();

  function line(a, b, p, style, width) {
    if (p <= 0) return;
    const [x0, y0] = project(a);
    const [x1, y1] = project(b);
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(lerp(x0, x1, p), lerp(y0, y1, p));
    ctx.stroke();
  }

  // The drawing at a given build state: edges (0..1), dims (0..1), scan (screen-x of the sweep, px).
  function blueprint({ edges = 1, dims = 1, scan = -1, fade = 1 }) {
    ctx.save();
    ctx.globalAlpha *= fade;
    const lw = Math.max(1, 0.18 * u);
    EDGES.forEach(([a, b], i) => {
      const p = E.outExpo(clamp(edges * 1.6 - i * 0.12));
      glow(C.cyan, 1.5 * u, () => line(a, b, p, 'rgba(233,236,255,.9)', lw));
    });
    DIMS.forEach(([a, b, label, side], i) => {
      const p = E.outCubic(clamp(dims * 1.5 - i * 0.2));
      if (p <= 0) return;
      line(a, b, p, brand(i / 2, 0.9), Math.max(1, 0.12 * u));
      const [x0, y0] = project(a);
      const [x1, y1] = project(b);
      const normal = Math.atan2(y1 - y0, x1 - x0) + Math.PI / 2;
      const tick = 1.1 * u;
      ctx.strokeStyle = brand(i / 2, 0.9);
      for (const [x, y] of [
        [x0, y0],
        [lerp(x0, x1, p), lerp(y0, y1, p)],
      ]) {
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(normal) * tick, y - Math.sin(normal) * tick);
        ctx.lineTo(x + Math.cos(normal) * tick, y + Math.sin(normal) * tick);
        ctx.stroke();
      }
      // Label runs along the line, just off it, and always reads left to right.
      let rot = Math.atan2(y1 - y0, x1 - x0);
      if (rot > Math.PI / 2) rot -= Math.PI;
      if (rot < -Math.PI / 2) rot += Math.PI;
      const off = side * 2.1 * u;
      ctx.save();
      ctx.translate(lerp(x0, x1, 0.5) - Math.sin(rot) * off, lerp(y0, y1, 0.5) + Math.cos(rot) * off);
      ctx.rotate(rot);
      text(label, 0, 0, { font: MONO, size: 1.7 * u, color: C.white, alpha: clamp((p - 0.6) / 0.4) });
      ctx.restore();
    });
    if (scan >= 0) {
      const size = Math.max(1.6, 0.46 * u);
      for (const pt of SAMPLES) {
        const [x, y] = project(pt);
        if (x > scan || x < -10 || y < -10 || y > H + 10 || x > W + 10) continue;
        const near = 1 - clamp((scan - x) / (14 * u));
        ctx.globalAlpha = fade * (0.5 + 0.5 * near);
        ctx.fillStyle = near > 0.02 ? brand(clamp(x / W)) : 'rgba(233,236,255,.8)';
        const s2 = size * (1 + near * 1.3);
        ctx.fillRect(x - s2 / 2, y - s2 / 2, s2, s2);
      }
      ctx.globalAlpha = fade;
      if (scan < W) {
        glow(C.cyan, 3 * u, () => {
          ctx.fillStyle = brandGradient(0, 0, 0, H);
          ctx.fillRect(scan - 0.2 * u, 0, 0.4 * u, H);
        });
      }
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------- */
  /* Scenes                                                            */
  /* ---------------------------------------------------------------- */

  const SCENES = [
    {
      // A dot becomes the logo, and the logo's brackets fly out to frame the shot.
      label: 'ORIGIN',
      dur: 1.6,
      ink: C.white,
      noCorners: true,
      draw(lt) {
        fill(C.black);
        const corner = project([0, 0, 0]);
        const move = E.cubic(seg(lt, 0.9, 1.55));
        const dx = lerp(W / 2, corner[0], move);
        const dy = lerp(H / 2, corner[1], move);
        const r = 1.1 * u * E.outBack(seg(lt, 0, 0.3));
        glow(C.cyan, 3 * u, () => circle(dx, dy, r, C.cyan));
        const pulse = seg(lt, 0.25, 0.9);
        if (pulse > 0 && pulse < 1) {
          ctx.beginPath();
          ctx.arc(W / 2, H / 2, r + pulse * 9 * u, 0, Math.PI * 2);
          ctx.strokeStyle = brand(0.2, 1 - pulse);
          ctx.lineWidth = Math.max(1, 0.2 * u);
          ctx.stroke();
        }
        // Logo brackets: snap in tight around the dot, then expand to the HUD corners.
        const snap = E.outBack(seg(lt, 0.2, 0.55));
        const fly = E.outExpo(seg(lt, 0.75, 1.5));
        if (snap > 0) {
          const m = 3 * u;
          const L = lerp(2 * u, 2.6 * u, fly);
          const hx = lerp(5 * u, W / 2 - m, fly) * snap;
          const hy = lerp(5 * u, H / 2 - m, fly) * snap;
          ctx.strokeStyle = lerp(0, 1, fly) > 0.98 ? C.white : brandGradient(W / 2 - hx, H / 2 - hy, W / 2 + hx, H / 2 + hy);
          ctx.lineWidth = lerp(0.5 * u, Math.max(1, 0.16 * u), fly);
          ctx.lineCap = 'round';
          for (const [sx, sy] of [
            [-1, -1],
            [1, -1],
            [-1, 1],
            [1, 1],
          ]) {
            const x = W / 2 + sx * hx;
            const y = H / 2 + sy * hy;
            ctx.beginPath();
            ctx.moveTo(x, y - sy * L);
            ctx.lineTo(x, y);
            ctx.lineTo(x - sx * L, y);
            ctx.stroke();
          }
        }
      },
    },
    {
      // From that dot, the room draws itself, with dimensions like a technical drawing.
      label: 'DRAW',
      dur: 1.5,
      ink: C.white,
      draw(lt) {
        fill(C.black);
        blueprint({ edges: seg(lt, 0, 1.0), dims: seg(lt, 0.55, 1.45) });
        glow(C.cyan, 3 * u, () => circle(...project([0, 0, 0]), 0.9 * u * (1 - seg(lt, 0.6, 1.2)), C.cyan));
      },
    },
    {
      // A LiDAR sweep fills the walls and floor with points.
      label: 'SCAN',
      dur: 1.5,
      ink: C.white,
      draw(lt) {
        fill(C.black);
        const scan = lerp(-0.02 * W, 1.04 * W, E.cubic(seg(lt, 0, 1.35)));
        blueprint({ scan });
        const n = Math.round(48210 * E.outCubic(seg(lt, 0, 1.35)));
        text(`${n.toLocaleString()} points`, W - 6 * u, H - 9 * u, { font: MONO, size: 1.7 * u, color: C.white, align: 'right', alpha: 0.75 });
      },
    },
    {
      // A scan line develops the drawing into the real room.
      label: 'REVEAL',
      dur: 1.3,
      ink: C.white,
      draw(lt) {
        fill(C.black);
        const p = E.cubic(seg(lt, 0, 1.0));
        const y = H * p;
        blueprint({ scan: W * 1.1, fade: 1 - seg(lt, 0.7, 1.3) });
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, W, y);
        ctx.clip();
        photo('empty', REVEAL_ZOOM);
        blueprint({ scan: -1, dims: 1, fade: 0.55 * (1 - seg(lt, 0.5, 1.3)) });
        ctx.restore();
        if (p > 0 && p < 1) {
          glow(C.cyan, 3 * u, () => {
            ctx.fillStyle = brandGradient(0, 0, W, 0);
            ctx.fillRect(0, y - 0.2 * u, W, 0.4 * u);
          });
        }
        text('living room · 4.20 × 3.40 m', W / 2, H - 9 * u, {
          font: MONO,
          size: 1.8 * u,
          color: C.white,
          alpha: E.outCubic(seg(lt, 0.6, 1.0)) * 0.85,
        });
      },
    },
    {
      // Point at the empty floor and say what you want.
      label: 'POINT',
      dur: 1.7,
      ink: C.white,
      draw(lt) {
        fill(C.black);
        const zoom = REVEAL_ZOOM + 0.03 * (lt / 1.7);
        const map = photo('empty', zoom);
        ctx.save();
        ctx.globalAlpha = E.outCubic(seg(lt, 0, 0.45));
        captionShade();
        ctx.restore();
        text('living room · 4.20 × 3.40 m', W / 2, H - 9 * u, {
          font: MONO,
          size: 1.8 * u,
          color: C.white,
          alpha: 0.85 * (1 - seg(lt, 0, 0.4)),
        });
        const [tx, ty] = map(0.57, 0.56);
        const beam = E.outExpo(seg(lt, 0.2, 0.6));
        if (beam > 0) {
          const g = ctx.createLinearGradient(W / 2, H, tx, ty);
          g.addColorStop(0, brand(0, 0));
          g.addColorStop(1, brand(0.5, 0.95));
          ctx.strokeStyle = g;
          ctx.lineWidth = Math.max(1, 0.3 * u);
          ctx.beginPath();
          ctx.moveTo(W / 2, H + 2 * u);
          ctx.lineTo(lerp(W / 2, tx, beam), lerp(H + 2 * u, ty, beam));
          ctx.stroke();
        }
        const snap = E.outBack(seg(lt, 0.45, 0.8));
        if (snap > 0) {
          glow(C.cyan, 2 * u, () =>
            brackets(tx, ty, lerp(14, 6, snap) * u, 2 * u, 0.45 * u, brandGradient(tx - 6 * u, ty - 6 * u, tx + 6 * u, ty + 6 * u)),
          );
          const pulse = seg(lt, 0.8, 1.6);
          ctx.beginPath();
          ctx.arc(tx, ty, 1 * u + pulse * 7 * u, 0, Math.PI * 2);
          ctx.strokeStyle = brand(0.2, 1 - pulse);
          ctx.lineWidth = Math.max(1, 0.2 * u);
          ctx.stroke();
          circle(tx, ty, 0.7 * u, C.cyan);
        }
        speak('“put a sofa there.”', W / 2, 14 * u, 6.5 * u, C.white, lt, { start: 0.5, per: 0.11 });
        waveform(W / 2, 23 * u, lt, E.outCubic(seg(lt, 0.4, 0.6)) * (1 - seg(lt, 1.4, 1.7)));
      },
    },
    {
      // The sofa materialises under a scan line, then the rest of the room follows.
      label: 'PLACE',
      dur: 2.1,
      ink: C.white,
      draw(lt) {
        fill(C.black);
        const zoom = 1.05 + 0.02 * (lt / 2.1);
        const first = seg(lt, 0.05, 0.75);
        const second = seg(lt, 1.15, 1.9);
        if (second > 0) scanReveal('sofa', 'full', second, zoom);
        else scanReveal('empty', 'sofa', first, zoom);
        captionShade(0.6);
        const tag = E.outCubic(seg(lt, 0.7, 0.95)) * (1 - seg(lt, 1.1, 1.25));
        if (tag > 0) {
          const [lx, ly] = photoPoint('sofa', zoom, 0.59, 0.45);
          text('sofa · 2.0 m · it fits', lx, ly, { font: MONO, size: 1.9 * u, color: C.cyan, alpha: tag });
        }
        speak('“and furnish the rest.”', W / 2, 14 * u, 6.5 * u, C.white, lt, { start: 0.95, per: 0.1 });
      },
    },
    {
      // "Make it warm": a bar of light wipes the room into a new palette.
      label: 'RESTYLE',
      dur: 1.7,
      ink: C.white,
      draw(lt) {
        fill(C.black);
        const zoom = 1.07 + 0.02 * (lt / 1.7);
        const wx = lerp(-0.05 * W, 1.05 * W, E.cubic(seg(lt, 0.4, 1.35)));
        photo('full', zoom);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, wx, H);
        ctx.clip();
        photo('warm', zoom);
        ctx.restore();
        if (wx > 0 && wx < W) {
          glow(C.cyan, 4 * u, () => {
            ctx.fillStyle = brandGradient(0, 0, 0, H);
            ctx.fillRect(wx - 0.25 * u, 0, 0.5 * u, H);
          });
        }
        captionShade(0.6);
        speak('“make it warm.”', W / 2, 14 * u, 6.5 * u, C.white, lt, { start: 0, per: 0.11 });
        waveform(W / 2, 23 * u, lt, E.outCubic(seg(lt, 0, 0.15)) * (1 - seg(lt, 0.5, 0.8)));
      },
    },
    {
      label: 'DEX',
      dur: 1.15,
      ink: C.white,
      draw(lt, p) {
        // The restyle wipe keeps going: the gradient sweeps in over the warm room.
        const wipe = E.cubic(seg(lt, 0, 0.3));
        if (wipe < 1) photo('warm', 1.09);
        ctx.fillStyle = brandGradient(0, 0, W, H);
        ctx.fillRect(0, 0, W * wipe, H);
        const s = 1.05 - 0.05 * E.outCubic(p);
        ctx.save();
        ctx.translate(W / 2, H / 2);
        ctx.scale(s, s);
        ctx.translate(-W / 2, -H / 2);
        riseWord('DEX', W / 2, H / 2 - 3 * u, 34 * u, C.white, lt, { stagger: 0.07, delay: 0.15 });
        text('reality editor', W / 2, H / 2 + 19 * u, {
          font: `italic ${SERIF}`,
          size: 7.5 * u,
          color: C.black,
          alpha: E.outCubic(seg(lt, 0.35, 0.75)) * 0.85,
        });
        ctx.restore();
      },
    },
    {
      // Three confident beats of type.
      label: 'YOU',
      dur: 1.65,
      ink: C.white,
      draw(lt) {
        const beats = [
          ['WALK IN.', C.black, C.white],
          ['SAY IT.', 'grad', C.white],
          ['LIVE IN IT.', C.mist, C.black],
        ];
        const i = Math.min(2, Math.floor(lt / 0.55));
        const [word, bg, ink] = beats[i];
        fill(bg === 'grad' ? brandGradient(0, 0, W, H) : bg);
        riseWord(word, W / 2, H / 2, 20 * u, ink, lt - i * 0.55, { stagger: 0.025, dur: 0.35 });
        this.ink = ink;
      },
    },
    {
      // The logo lockup, held while the intro fades away.
      label: 'DEX',
      dur: 2.0,
      ink: C.white,
      draw(lt) {
        fill(C.black);
        const halo = ctx.createRadialGradient(W / 2, H / 2 - 8 * u, 0, W / 2, H / 2 - 8 * u, 45 * u);
        halo.addColorStop(0, 'rgba(59,91,255,.28)');
        halo.addColorStop(1, 'rgba(59,91,255,0)');
        ctx.globalAlpha = E.outCubic(seg(lt, 0, 0.6));
        fill(halo);
        ctx.globalAlpha = 1;

        const spin = E.outBack(seg(lt, 0, 0.55));
        const cy = H / 2 - 9 * u;
        ctx.save();
        ctx.translate(W / 2, cy);
        ctx.rotate((1 - spin) * -Math.PI);
        glow(C.blue, 8 * u, () => cube(0, 0, 9 * u * spin, '#8ff0fb', C.blue, '#7c4dff', 'rgba(255,255,255,.85)'));
        ctx.restore();

        const br = E.outExpo(seg(lt, 0.2, 0.7));
        ctx.globalAlpha = br;
        brackets(W / 2, cy, lerp(20, 14, br) * u, 4 * u, 0.9 * u, brandGradient(W / 2 - 14 * u, cy - 14 * u, W / 2 + 14 * u, cy + 14 * u));
        ctx.globalAlpha = 1;

        riseWord('Dex', W / 2, H / 2 + 16 * u, 15 * u, C.white, lt, { delay: 0.4, stagger: 0.06, dur: 0.6 });
        text('talk to your room', W / 2, H / 2 + 28 * u, {
          font: `italic ${SERIF}`,
          size: 4.2 * u,
          color: C.cyan,
          alpha: E.outCubic(seg(lt, 0.8, 1.2)),
        });
      },
    },
  ];

  const TOTAL = SCENES.reduce((a, s) => a + s.dur, 0);

  function sceneAt(t) {
    let acc = 0;
    for (let i = 0; i < SCENES.length; i++) {
      const s = SCENES[i];
      if (t < acc + s.dur) return { s, i, lt: t - acc };
      acc += s.dur;
    }
    const last = SCENES.length - 1;
    return { s: SCENES[last], i: last, lt: SCENES[last].dur };
  }

  /* ---------------------------------------------------------------- */
  /* HUD + grain, drawn over every scene                               */
  /* ---------------------------------------------------------------- */

  const grain = (() => {
    const g = document.createElement('canvas');
    g.width = g.height = 160;
    const gx = g.getContext('2d');
    const img = gx.createImageData(160, 160);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    gx.putImageData(img, 0, 0);
    return g;
  })();

  function hud(t, i, s) {
    const ink = s.ink;
    const m = 3 * u;
    const L = 2.6 * u;
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(1, 0.16 * u);
    ctx.globalAlpha = s.noCorners ? 0 : 0.85;
    for (const [x, y, dx, dy] of [
      [m, m, 1, 1],
      [W - m, m, -1, 1],
      [m, H - m, 1, -1],
      [W - m, H - m, -1, -1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(x, y + dy * L);
      ctx.lineTo(x, y);
      ctx.lineTo(x + dx * L, y);
      ctx.stroke();
    }
    const k = s.noCorners ? seg(t, 0.9, 1.6) : 1; // labels arrive with the brackets
    const small = Math.max(10, 1.5 * u);
    const top = m + 1.2 * u;
    text('DEX — REALITY EDITOR', m + L + 1.5 * u, top, { font: MONO, size: small, color: ink, align: 'left', alpha: 0.8 * k });
    text(`S${String(i + 1).padStart(2, '0')} · ${s.label}`, W / 2, top, { font: MONO, size: small, color: ink, alpha: 0.6 * k });

    const y = H - m - 1.2 * u;
    const secs = Math.floor(t);
    const frames = Math.floor((t % 1) * 24);
    const code = `00:${String(secs).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
    const end = `${TOTAL.toFixed(1)}s`;
    ctx.font = `${small}px ${MONO}`;
    const gap = Math.max(10, 1.5 * u);
    const x0 = m + L + gap + ctx.measureText(code).width + gap;
    const x1 = W - m - L - gap - ctx.measureText(end).width - gap;
    text(code, m + L + 1.5 * u, y, { font: MONO, size: small, color: ink, align: 'left', alpha: 0.8 * k });
    text(end, W - m - L - 1.5 * u, y, { font: MONO, size: small, color: ink, align: 'right', alpha: 0.8 * k });
    ctx.globalAlpha = 0.25 * k;
    ctx.fillStyle = ink;
    ctx.fillRect(x0, y, x1 - x0, 1);
    ctx.globalAlpha = k;
    ctx.fillStyle = ink === C.white ? brandGradient(x0, 0, x1, 0) : ink;
    ctx.fillRect(x0, y - 0.5, (x1 - x0) * (t / TOTAL), 2);
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.globalAlpha = 0.07;
    ctx.globalCompositeOperation = 'overlay';
    ctx.translate(Math.random() * 160, Math.random() * 160);
    ctx.fillStyle = ctx.createPattern(grain, 'repeat');
    ctx.fillRect(-160, -160, W + 320, H + 320);
    ctx.restore();
  }

  /* ---------------------------------------------------------------- */
  /* Playback: once through, then hand over to the landing page        */
  /* ---------------------------------------------------------------- */

  const FADE_AT = TOTAL - 0.7; // start revealing the page while the lockup holds
  let t = 0;
  let last = 0;
  let raf = 0;
  let running = false;
  let fading = false;
  let started = false; // set once the intro has played or been skipped

  function render() {
    const { s, i, lt } = sceneAt(t);
    ctx.save();
    s.draw(lt, lt / s.dur);
    ctx.restore();
    hud(t, i, s);
  }

  function frame(now) {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    t = Math.min(TOTAL, t + dt);
    render();
    if (t >= FADE_AT && !fading) finish();
    if (t < TOTAL) raf = requestAnimationFrame(frame);
    else running = false;
  }

  function finish() {
    if (fading) return;
    fading = true;
    started = true;
    intro.classList.add('is-leaving');
    document.body.classList.remove('intro-active');
    document.dispatchEvent(new Event('dex:intro-done'));
    setTimeout(() => {
      cancelAnimationFrame(raf);
      running = false;
      intro.hidden = true;
      intro.classList.remove('is-leaving');
    }, 900);
  }

  // Always open on the intro from the top, not wherever the last visit left off.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  function play() {
    cancelAnimationFrame(raf);
    t = 0;
    last = 0;
    fading = false;
    intro.hidden = false;
    document.body.classList.add('intro-active');
    window.scrollTo(0, 0);
    resize();
    running = true;
    raf = requestAnimationFrame(frame);
    document.getElementById('introSkip')?.focus({ preventScroll: true });
  }

  document.getElementById('introSkip')?.addEventListener('click', finish);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && running && !fading) finish();
  });
  new ResizeObserver(() => {
    if (!running) return;
    resize();
    render();
  }).observe(canvas);

  // Debug/preview hook: DexIntro.seek(seconds) renders a single frame.
  window.DexIntro = {
    replay: play,
    skip: finish,
    seek(sec) {
      cancelAnimationFrame(raf);
      running = false;
      intro.hidden = false;
      resize();
      t = clamp(sec, 0, TOTAL);
      render();
    },
    duration: TOTAL,
  };

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    intro.hidden = true;
    document.body.classList.remove('intro-active');
    document.dispatchEvent(new Event('dex:intro-done'));
    return;
  }

  // Wait for the display faces so the first frames don't flash a fallback font.
  const start = () => {
    if (started) return;
    started = true;
    play();
  };
  Promise.all([
    photosReady,
    ...[`40px ${DISPLAY}`, `italic 40px ${SERIF}`, `20px ${MONO}`].map((f) => document.fonts.load(f)),
  ]).then(start, start);
  setTimeout(start, 2500);
})();
