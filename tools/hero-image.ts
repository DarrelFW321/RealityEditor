/**
 * Regenerates the welcome screen's hero image.
 *
 * `npx tsx tools/hero-image.ts`
 *
 * One-off, deliberately. The image is committed as an asset and this exists so it can be
 * made again with a changed prompt rather than being an artefact nobody can reproduce —
 * not so it runs on every build. It spends credits on the same Backboard key and the same
 * image model `POST /inpaint` uses, read from `server/.env`.
 *
 * The room render on the choice screen is NOT this. That one has to be the user's actual
 * measured room, so it stays a render of the scene graph; this is only the picture on the
 * screen before there is a room to show.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

// Run from the repo root; the root package.json has no `type: module`, so tsx
// compiles this to CJS and neither `import.meta` nor top-level await is available.
const root = resolve(process.cwd());
const env = new Map(
  readFileSync(resolve(root, 'server/.env'), 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1).trim()] as const;
    }),
);

async function main() {
const key = env.get('BACKBOARD_API_KEY');
const baseURL = env.get('BACKBOARD_BASE_URL') ?? 'https://app.backboard.io/api';
const provider = env.get('INPAINT_IMAGE_PROVIDER');
const model = env.get('INPAINT_MODEL');
if (!key || !provider || !model) throw new Error('BACKBOARD_API_KEY, INPAINT_IMAGE_PROVIDER and INPAINT_MODEL must be set in server/.env');

const PROMPT = [
  'A single isometric 3D cutaway render of one modern home garage, presented as a small',
  'floating diorama: a concrete floor slab with visible thickness and exactly two back',
  'walls, open on the two near sides so the interior is visible from above at a',
  'three-quarter angle.',
  '',
  'DARK THEME. The background is a flat, very dark blue-black, hex #0C1420, filling the',
  'whole frame. The garage itself is dark: charcoal walls, polished dark grey concrete',
  'floor. It is lit from inside by a warm amber work lamp and cool blue LED strip',
  'lighting along the top edges of the walls, so the diorama glows softly against the',
  'dark background.',
  '',
  'Contents, arranged with space between them and none of them overlapping:',
  'a silver Porsche 911 sports car parked at an angle on the open floor, the hero of the',
  'scene;',
  'a black power squat rack with a loaded barbell against one wall;',
  'a gaming desk against the other wall with two monitors glowing, a keyboard and a',
  'chair;',
  'a tall dark bookshelf beside the desk with books and a small plant.',
  '',
  'Sparse and calm, not cluttered. The car is clearly the largest object.',
  '',
  'The diorama floats in empty dark space. NO ground circle, NO ellipse, NO ring, NO',
  'platform, NO pedestal, NO shadow disc beneath it, NO reflection. NO text, NO letters,',
  'NO numbers, NO logos, NO watermarks, NO user interface, NO buttons, NO arrows.',
  '',
  'Centred, with generous empty dark space around all four sides. Soft matte materials,',
  'gentle ambient occlusion, slight depth of field. Clean premium app illustration.',
].join(' ');

const form = new FormData();
form.append('content', PROMPT);
form.append('image_generation', 'auto');
form.append('image_model_provider', provider);
form.append('image_model_name', model);

console.log(`Asking ${provider}/${model} for the hero image…`);
const response = await fetch(`${baseURL}/threads/messages`, {
  method: 'POST',
  // X-API-Key, not Bearer: Backboard ignores an Authorization header, which reads as a
  // 401 nobody can explain. Same header `POST /inpaint` sends.
  headers: { 'X-API-Key': key },
  body: form,
  signal: AbortSignal.timeout(300_000),
});
const text = await response.text();
if (!response.ok) throw new Error(`Backboard refused: ${response.status} ${text.slice(0, 400)}`);
const body = JSON.parse(text) as unknown;

/** The artifact comes back as a URL somewhere in the reply, not as base64. */
function findImageUrl(node: unknown, depth = 0): string | null {
  if (depth > 6 || node === null || typeof node !== 'object') return null;
  for (const value of Object.values(node as Record<string, unknown>)) {
    if (typeof value === 'string' && /^https:\/\/\S+\.(png|jpe?g|webp)(\?|$)/i.test(value)) return value;
    const nested = findImageUrl(value, depth + 1);
    if (nested) return nested;
  }
  return null;
}

const url = findImageUrl(body);
if (!url) throw new Error(`No image in the reply. Keys: ${Object.keys(body as object).join(', ')}`);
const asset = await fetch(url, { signal: AbortSignal.timeout(120_000) });
if (!asset.ok) throw new Error(`Could not fetch the artifact: ${asset.status}`);
const bytes = Buffer.from(await asset.arrayBuffer());

/**
 * The untouched artifact, kept OUTSIDE the repo.
 *
 * Too large to commit — it came back at 4096x4096 and 3.5MB last time — but throwing it
 * away means the only way to try a different crop or a different background is another
 * generation, which returns a different room. Left in the temp directory and named, so
 * `python3 tools/seat-hero.py <that> mobile/assets/hero-room.jpg '#0c1420'` can be run
 * again on the same picture.
 */
const raw = resolve(tmpdir(), `hero-room-${Date.now()}.png`);
const out = resolve(root, 'mobile/assets/hero-room.jpg');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(raw, bytes);

/**
 * The model is ASKED for #0C1420 and returns something near it — #0A111B last time,
 * which is ten units of constant offset and shows as a rectangle of slightly-wrong dark
 * behind the diorama. `seat-hero.py` moves the flat field onto the real colour without
 * touching the lit parts. Python because Pillow is already how this repo does pixels;
 * `npm run gate` shells out to python3 for the reconstruction worker for the same reason.
 */
execFileSync('python3', [resolve(root, 'tools/seat-hero.py'), raw, out, '#0c1420'], {
  stdio: 'inherit',
});
console.log(`Wrote ${out}`);
console.log(`Untouched artifact kept at ${raw}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
