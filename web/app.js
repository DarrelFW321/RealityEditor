// A toy Reality Editor for the browser. Everything is fake except the geometry:
// 1px = 1cm, and a tiny solver really does check collisions and the door swing.

const ROOM = { w: 420, d: 340, h: 130 };
const DOOR = { x: 0, y: 200, w: 90, d: 90 }; // swing zone on the floor, hinge on the west wall
const WINDOW = { x: 240, w: 120 }; // along the north wall

// Colours come straight from catalog/manifest.json.
const THEMES = {
  warm: { label: 'Warm', floor: '#7f6042', wall: '#f2ede4', fabric: '#c5af98', wood: '#a17e57', accent: '#54493d', green: '#4f7a4a' },
  japandi: { label: 'Japandi', floor: '#d2ad80', wall: '#eceae5', fabric: '#e8d3bb', wood: '#423021', accent: '#797670', green: '#6b8f5e' },
  moody: { label: 'Moody', floor: '#423021', wall: '#72695a', fabric: '#ad2d47', wood: '#512d10', accent: '#b19d7a', green: '#3f6b45' },
  gallery: { label: 'Gallery', floor: '#bbb2a3', wall: '#fbfaf8', fabric: '#797670', wood: '#7e6240', accent: '#dfe7ea', green: '#5a8a52' },
};

// Furniture recipes: footprint (w × d), preferred spot, and parts in local cm.
// Part: [x, y, w, d, h, z, colourSlot]
const RECIPES = {
  sofa: {
    name: 'sofa', words: ['sofa', 'couch'], w: 200, d: 90, at: [30, 240], wall: 'south',
    parts: [[0, 0, 200, 90, 38, 0, 'fabric'], [0, 68, 200, 22, 80, 0, 'fabric'], [0, 0, 20, 90, 56, 0, 'fabric'], [180, 0, 20, 90, 56, 0, 'fabric'], [22, 4, 78, 62, 10, 38, 'fabric'], [100, 4, 78, 62, 10, 38, 'fabric']],
  },
  table: {
    name: 'coffee table', words: ['coffee table', 'table'], w: 110, d: 60, at: [155, 150],
    parts: [[0, 0, 110, 60, 6, 36, 'wood'], [4, 4, 6, 6, 36, 0, 'accent'], [100, 4, 6, 6, 36, 0, 'accent'], [4, 50, 6, 6, 36, 0, 'accent'], [100, 50, 6, 6, 36, 0, 'accent']],
  },
  rug: {
    name: 'rug', words: ['rug', 'carpet'], w: 240, d: 160, at: [90, 90], flat: true,
    parts: [[0, 0, 240, 160, 1, 0, 'fabric']],
  },
  shelf: {
    name: 'bookshelf', words: ['bookshelf', 'bookcase', 'shelf', 'shelves'], w: 90, d: 32, at: [250, 0], tall: true, wall: 'north',
    parts: [[0, 0, 90, 32, 170, 0, 'wood'], [6, 30, 78, 3, 34, 8, 'accent'], [6, 30, 78, 3, 30, 50, 'fabric'], [6, 30, 78, 3, 32, 90, 'accent'], [6, 30, 78, 3, 28, 130, 'fabric']],
  },
  plant: {
    name: 'plant', words: ['plant', 'monstera', 'tree', 'fern'], w: 44, d: 44, at: [366, 10],
    parts: [[6, 6, 32, 32, 36, 0, 'accent'], [0, 0, 44, 44, 34, 36, 'green'], [8, 8, 28, 28, 26, 70, 'green']],
  },
  lamp: {
    name: 'floor lamp', words: ['lamp', 'light'], w: 36, d: 36, at: [14, 14],
    parts: [[3, 3, 30, 30, 4, 0, 'accent'], [15, 15, 6, 6, 128, 4, 'accent'], [0, 0, 36, 36, 30, 128, 'wall']],
  },
  chair: {
    name: 'armchair', words: ['armchair', 'chair', 'seat'], w: 80, d: 80, at: [330, 150],
    parts: [[0, 0, 80, 80, 40, 0, 'fabric'], [64, 0, 16, 80, 80, 0, 'fabric'], [0, 0, 80, 14, 56, 0, 'fabric'], [0, 66, 80, 14, 56, 0, 'fabric']],
  },
  desk: {
    name: 'desk', words: ['desk', 'workstation'], w: 130, d: 60, at: [140, 0], wall: 'north',
    parts: [[0, 0, 130, 60, 5, 70, 'wood'], [0, 0, 6, 60, 70, 0, 'accent'], [124, 0, 6, 60, 70, 0, 'accent']],
  },
  bed: {
    name: 'queen bed', words: ['bed'], w: 160, d: 200, at: [240, 140], big: true,
    parts: [[0, 0, 160, 200, 30, 0, 'wood'], [4, 4, 152, 192, 18, 30, 'wall'], [0, 186, 160, 14, 90, 0, 'wood'], [14, 150, 58, 34, 10, 48, 'fabric'], [88, 150, 58, 34, 10, 48, 'fabric']],
  },
};

const SUGGESTIONS = [
  'Put a sofa by the door',
  'Add a bookshelf under the window',
  'Throw a rug down',
  'Coffee table in the middle',
  'Make it japandi',
  'Add a grand piano',
  'Can a queen bed fit?',
  'Remove the rug',
];

/* ------------------------------------------------------------------ */
/* Room renderer                                                       */
/* ------------------------------------------------------------------ */

function el(tag, cls, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}

function px(n) {
  return `${n}px`;
}

function face(parent, cls, w, h, transform) {
  const f = el('div', `face ${cls}`, parent);
  f.style.width = px(w);
  f.style.height = px(h);
  f.style.transform = transform;
  return f;
}

// A solid box of w × d × h sitting at z. Faces point outward so back faces can be culled.
function buildBox(parent, [x, y, w, d, h, z, slot]) {
  const b = el('div', 'part', parent);
  Object.assign(b.style, { position: 'absolute', left: px(x), top: px(y), width: px(w), height: px(d), transform: `translateZ(${z}px)` });
  b.style.setProperty('--c', `var(--${slot})`);
  face(b, 'top', w, d, `translateZ(${h}px)`);
  face(b, 'n', w, h, 'rotateX(90deg)');
  face(b, 's', w, h, `translateY(${d}px) translateZ(${h}px) rotateX(-90deg)`);
  face(b, 'w', h, d, 'rotateY(-90deg)');
  face(b, 'e', h, d, `translateX(${w}px) translateZ(${h}px) rotateY(90deg)`);
  return b;
}

function createRoom(host, { baseScale = 1 } = {}) {
  const scene = el('div', 'scene', host);
  scene.style.width = px(ROOM.w);
  scene.style.height = px(ROOM.d);
  el('div', 'floor', scene);

  // Walls face into the room, so whichever two are nearest the camera cull themselves.
  const { w, d, h } = ROOM;
  const walls = [
    ['n', w, h, `translateZ(${h}px) rotateX(-90deg)`, 0.96],
    ['s', w, h, `translateY(${d}px) rotateX(90deg)`, 0.9],
    ['w', h, d, `translateZ(${h}px) rotateY(90deg)`, 0.8],
    ['e', h, d, `translateX(${w}px) rotateY(-90deg)`, 0.84],
  ];
  const wallEls = {};
  for (const [side, ww, hh, t, shade] of walls) {
    const wall = el('div', `wall wall-${side}`, scene);
    Object.assign(wall.style, { width: px(ww), height: px(hh), transform: t, filter: `brightness(${shade})`, backfaceVisibility: 'hidden' });
    wallEls[side] = wall;
  }
  // North wall is drawn top-down from ceiling to floor, so the window sits near its top.
  const win = el('div', 'window', wallEls.n);
  Object.assign(win.style, { left: px(WINDOW.x), top: px(22), width: px(WINDOW.w), height: px(66) });
  // West wall runs ceiling (x=0) → floor (x=h) across, y along its height.
  const door = el('div', 'window', wallEls.w);
  Object.assign(door.style, { left: px(10), top: px(DOOR.y), width: px(h - 10), height: px(DOOR.d), background: 'var(--wood)', boxShadow: 'inset 0 0 0 3px rgba(0,0,0,.25)' });

  const swing = el('div', 'door-swing', scene);
  Object.assign(swing.style, { left: px(DOOR.x), top: px(DOOR.y), width: px(DOOR.w), height: px(DOOR.d) });

  const clearance = el('div', 'clearance', scene);

  const items = new Map();
  let angle = 45;
  let scale = baseScale;

  function applyTransform() {
    scene.style.transform = `translateY(${50 * scale}px) scale(${scale}) rotateX(58deg) rotateZ(${angle}deg)`;
  }

  function fit() {
    const r = host.getBoundingClientRect();
    scale = Math.max(0.35, Math.min(r.width / 700, r.height / 600)) * baseScale;
    applyTransform();
  }

  function setTheme(key) {
    const t = THEMES[key];
    for (const slot of ['floor', 'wall', 'fabric', 'wood', 'accent', 'green']) {
      scene.style.setProperty(`--${slot}`, t[slot]);
    }
  }

  function add(id, recipe, x, y, { ghost = false } = {}) {
    const g = el('div', 'box enter', scene);
    Object.assign(g.style, { left: px(x), top: px(y), width: px(recipe.w), height: px(recipe.d) });
    if (ghost) {
      g.classList.add('ghost');
    }
    for (const p of recipe.parts) buildBox(g, p);
    g.addEventListener('animationend', () => g.classList.remove('enter'), { once: true });
    items.set(id, { el: g, recipe, x, y });
    return items.get(id);
  }

  function move(id, x, y) {
    const it = items.get(id);
    if (!it) return;
    it.x = x;
    it.y = y;
    it.el.style.left = px(x);
    it.el.style.top = px(y);
  }

  function remove(id) {
    const it = items.get(id);
    if (!it) return;
    items.delete(id);
    it.el.classList.add('leave');
    setTimeout(() => it.el.remove(), 450);
  }

  function highlight(id) {
    const it = items.get(id);
    if (!it) return;
    it.el.classList.add('selected');
    setTimeout(() => it.el.classList.remove('selected'), 1600);
  }

  function flashClearance(rect) {
    Object.assign(clearance.style, { left: px(rect.x), top: px(rect.y), width: px(rect.w), height: px(rect.d) });
    clearance.classList.remove('show');
    void clearance.offsetWidth;
    clearance.classList.add('show');
  }

  function scan() {
    scene.classList.add('scanning');
    setTimeout(() => scene.classList.remove('scanning'), 1400);
  }

  function rotate(delta) {
    angle += delta;
    applyTransform();
  }

  new ResizeObserver(fit).observe(host);
  fit();
  setTheme('warm');

  return { items, add, move, remove, highlight, flashClearance, setTheme, rotate, scan };
}

/* ------------------------------------------------------------------ */
/* Solver-lite                                                         */
/* ------------------------------------------------------------------ */

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.d && b.y < a.y + a.d;
}

// Returns the first reason a footprint cannot go at (x, y), or null.
function conflict(room, recipe, x, y, ignoreId) {
  const r = { x, y, w: recipe.w, d: recipe.d };
  if (x < 0 || y < 0 || x + r.w > ROOM.w || y + r.d > ROOM.d) return { kind: 'walls' };
  if (!recipe.flat && overlaps(r, DOOR)) return { kind: 'door_swing', rect: DOOR };
  if (recipe.tall && y < 40 && overlaps(r, { x: WINDOW.x, y: 0, w: WINDOW.w, d: 40 })) {
    return { kind: 'window', rect: { x: WINDOW.x, y: 0, w: WINDOW.w, d: 40 } };
  }
  for (const [id, it] of room.items) {
    if (id === ignoreId || it.recipe.flat || recipe.flat) continue;
    if (overlaps(r, { x: it.x, y: it.y, w: it.recipe.w, d: it.recipe.d })) {
      return { kind: 'collision', with: it.recipe.name, rect: { x: it.x, y: it.y, w: it.recipe.w, d: it.recipe.d } };
    }
  }
  return null;
}

// Nearest legal spot to the preferred one, searching outward in 10cm steps.
function solve(room, recipe, [px0, py0], ignoreId) {
  const first = conflict(room, recipe, px0, py0, ignoreId);
  if (!first) return { x: px0, y: py0, first: null };
  let best = null;
  for (let x = 0; x + recipe.w <= ROOM.w; x += 10) {
    for (let y = 0; y + recipe.d <= ROOM.d; y += 10) {
      if (recipe.wall === 'north' && y !== 0) continue;
      if (recipe.wall === 'south' && y + recipe.d < ROOM.d - 20) continue;
      if (conflict(room, recipe, x, y, ignoreId)) continue;
      const dist = Math.hypot(x - px0, y - py0);
      if (!best || dist < best.dist) best = { x, y, dist };
    }
  }
  return best ? { x: best.x, y: best.y, first } : { first, refused: true };
}

function describeShift(dx, dy) {
  const parts = [];
  if (dx) parts.push(`${Math.abs(dx)}cm ${dx > 0 ? 'right' : 'left'}`);
  if (dy) parts.push(`${Math.abs(dy)}cm ${dy > 0 ? 'forward' : 'back'}`);
  return parts.join(' and ');
}

const REASONS = {
  door_swing: 'so the door still opens',
  window: 'to keep the window clear',
  collision: (w) => `so it doesn’t hit the ${w}`,
  walls: 'to keep it inside the room',
};

function reasonText(c) {
  const r = REASONS[c.kind];
  return typeof r === 'function' ? r(c.with) : r;
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

const room = createRoom(document.getElementById('editorRoom'));
const log = document.getElementById('log');
const status = document.getElementById('status');
const countLabel = document.getElementById('countLabel');
const input = document.getElementById('prompt');
let busy = false;
let nextId = 1;
let theme = 'warm';

function updateCount() {
  const n = room.items.size;
  countLabel.textContent = `${n} object${n === 1 ? '' : 's'}`;
}

function scrollLog() {
  log.scrollTop = log.scrollHeight;
}

function say(who, html, { report, refused } = {}) {
  const li = el('li', `msg ${who}${refused ? ' refused' : ''}`, log);
  li.innerHTML = html;
  if (report) {
    const r = el('span', 'report', li);
    r.textContent = report;
  }
  scrollLog();
  return li;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function thinking(ms = 700) {
  status.textContent = 'Solving…';
  const li = say('dex', '<span class="typing"><i></i><i></i><i></i></span>');
  return new Promise((res) =>
    setTimeout(() => {
      li.remove();
      status.textContent = 'Listening';
      res();
    }, ms),
  );
}

function findItem(name) {
  for (const [id, it] of room.items) {
    if (it.recipe.words?.some((w) => name.includes(w)) || name.includes(it.recipe.name)) return id;
  }
  return null;
}

function matchRecipe(text) {
  for (const r of Object.values(RECIPES)) {
    if (r.words.some((w) => text.includes(w))) return r;
  }
  return null;
}

function m(n) {
  return (n / 100).toFixed(2);
}

function place(recipe) {
  if (recipe.big && room.items.size > 1) {
    return say(
      'dex',
      `<b>No — it won’t fit honestly.</b> A queen bed is 160×200cm. With what’s already here, the only open space is across the door swing.`,
      { refused: true, report: `op    place(${recipe.name})\ncheck clearance ✗  largest free rect < 160×200\nresult REFUSED` },
    );
  }
  const existing = findItem(recipe.name);
  if (existing) room.remove(existing);

  const res = solve(room, recipe, recipe.at);
  if (res.refused) {
    return say('dex', `<b>There’s nowhere for a ${recipe.name}</b> that keeps the room usable.`, {
      refused: true,
      report: `op    place(${recipe.name})\ncheck ${res.first.kind} ✗\nresult REFUSED`,
    });
  }

  const id = `o${nextId++}`;
  const [ax, ay] = recipe.at;
  const moved = res.first && (res.x !== ax || res.y !== ay);
  room.add(id, recipe, moved ? ax : res.x, moved ? ay : res.y);
  updateCount();

  if (moved) {
    setTimeout(() => {
      if (res.first.rect) room.flashClearance(res.first.rect);
      room.move(id, res.x, res.y);
      room.highlight(id);
    }, 650);
    say('dex', `Placed the ${recipe.name}. I shifted it <b>${describeShift(res.x - ax, res.y - ay)}</b> ${reasonText(res.first)}.`, {
      report: `op    place(${recipe.name}, near, ${recipe.wall ? `wall.${recipe.wall}` : 'intent'})\ncheck ${res.first.kind} ✗ → shift\ncheck collisions ✓\npose  (${m(res.x)}, ${m(res.y)}) m`,
    });
  } else {
    room.highlight(id);
    say('dex', `Done — the ${recipe.name} is in. ${recipe.flat ? 'Rugs don’t block anything, so it sits under the rest.' : 'Every clearance checks out.'}`, {
      report: `op    place(${recipe.name})\ncheck clearance ✓  door_swing ✓\npose  (${m(res.x)}, ${m(res.y)}) m`,
    });
  }
}

function generate(noun) {
  const size = 50 + Math.round(Math.random() * 30);
  const recipe = {
    name: noun,
    words: [noun],
    w: size,
    d: size,
    at: [180, 120],
    parts: [[0, 0, size, size, 20, 0, 'accent'], [8, 8, size - 16, size - 16, 50, 20, 'wood']],
  };
  const res = solve(room, recipe, recipe.at);
  if (res.refused) return say('dex', `There’s no free floor left for a ${escapeHtml(noun)}.`, { refused: true });

  const id = `o${nextId++}`;
  const it = room.add(id, recipe, res.x, res.y, { ghost: true });
  updateCount();
  const li = say('dex', `Nothing in the catalog matches “${escapeHtml(noun)}”, so I’m <b>generating it</b>. Geometry first, materials next.`, {
    report: `op    generate("${noun}")\ncatalog  no match\ntext→3D  ~90s  (sped up for the demo)`,
  });
  status.textContent = 'Generating…';
  setTimeout(() => {
    it.el.classList.remove('ghost');
    room.highlight(id);
    status.textContent = 'Listening';
    const done = el('span', 'report', li);
    done.textContent = `materials ✓  placed at (${m(res.x)}, ${m(res.y)}) m`;
    scrollLog();
  }, 2600);
}

function nudge(text) {
  const id = findItem(text);
  if (!id) return say('dex', 'Which one? I don’t see that in the room yet.');
  const it = room.items.get(id);
  const step = 50;
  const delta = /left/.test(text) ? [-step, 0] : /right/.test(text) ? [step, 0] : /back/.test(text) ? [0, -step] : [0, step];
  const target = [it.x + delta[0], it.y + delta[1]];
  const c = conflict(room, it.recipe, ...target, id);
  if (c) {
    if (c.rect) room.flashClearance(c.rect);
    return say('dex', `<b>I can’t move it there</b> — that would block ${c.kind === 'door_swing' ? 'the door' : c.kind === 'collision' ? `the ${c.with}` : 'a wall'}.`, {
      refused: true,
      report: `op    move(${it.recipe.name}, ${describeShift(...delta)})\ncheck ${c.kind} ✗\nresult REFUSED`,
    });
  }
  room.move(id, ...target);
  room.highlight(id);
  say('dex', `Moved the ${it.recipe.name} <b>${describeShift(...delta)}</b>.`, {
    report: `op    move(${it.recipe.name})\npose  (${m(target[0])}, ${m(target[1])}) m`,
  });
}

function setTheme(key) {
  theme = key;
  room.setTheme(key);
  document.querySelectorAll('.theme-dot').forEach((d) => d.classList.toggle('active', d.dataset.theme === key));
}

async function handle(raw) {
  const text = raw.trim().toLowerCase();
  if (!text || busy) return;
  busy = true;
  say('user', escapeHtml(raw.trim()));
  input.value = '';
  await thinking();

  const themeKey = Object.keys(THEMES).find((k) => text.includes(k)) || (/(dark|cozy|cosy)/.test(text) ? 'moody' : /(scandi|minimal|light)/.test(text) ? 'gallery' : null);

  if (/\b(clear|empty|reset|start over)\b/.test(text)) {
    for (const id of [...room.items.keys()]) room.remove(id);
    room.scan();
    updateCount();
    say('dex', 'Cleared. Back to the bare scan.');
  } else if (/\b(remove|delete|get rid of|take out|lose)\b/.test(text)) {
    const id = findItem(text) || [...room.items.keys()].pop();
    if (!id) {
      say('dex', 'The room’s already empty.');
    } else {
      const name = room.items.get(id).recipe.name;
      room.remove(id);
      updateCount();
      say('dex', `Removed the ${escapeHtml(name)}.`, { report: `op    remove(${name})` });
    }
  } else if (/\b(move|shift|push|slide|nudge)\b/.test(text)) {
    nudge(text);
  } else if (themeKey && !matchRecipe(text)) {
    setTheme(themeKey);
    say('dex', `Restyled as <b>${THEMES[themeKey].label}</b>. Same layout, new materials — nothing moved.`, {
      report: `op    restyle(${themeKey})\nfloor ${THEMES[themeKey].floor}  wall ${THEMES[themeKey].wall}`,
    });
  } else if (matchRecipe(text)) {
    place(matchRecipe(text));
  } else {
    const noun = text.match(/(?:add|put|place|want|need|get|make)\s+(?:a|an|some|the|me a)?\s*([a-z][a-z\s-]{1,30}?)(?:\s+(?:in|by|near|over|on|under|next|here|there)\b|[?.!]|$)/);
    if (noun) {
      generate(noun[1].trim());
    } else {
      say('dex', 'Tell me what to add, move, remove or restyle — like “put a lamp in the corner” or “make it moody”.');
    }
  }
  busy = false;
}

// Wire up UI
const chips = document.getElementById('chips');
for (const s of SUGGESTIONS) {
  const b = el('button', 'chip', chips);
  b.type = 'button';
  b.textContent = s;
  b.addEventListener('click', () => handle(s));
}

const themes = document.getElementById('themes');
for (const [key, t] of Object.entries(THEMES)) {
  const d = el('button', 'theme-dot', themes);
  d.type = 'button';
  d.dataset.theme = key;
  d.title = t.label;
  d.setAttribute('aria-label', `${t.label} style`);
  d.style.setProperty('--a', t.floor);
  d.style.setProperty('--b', t.fabric);
  d.addEventListener('click', () => {
    if (key !== theme) {
      setTheme(key);
      say('dex', `Switched to <b>${t.label}</b>.`);
    }
  });
}
setTheme('warm');

document.getElementById('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  handle(input.value);
});
document.getElementById('rotL').addEventListener('click', () => room.rotate(-90));
document.getElementById('rotR').addEventListener('click', () => room.rotate(90));
document.getElementById('reset').addEventListener('click', () => handle('reset'));


room.scan();
say('dex', 'Room scanned — <b>4.2 × 3.4 m</b>, one door, one window. What should we do with it?');
updateCount();
