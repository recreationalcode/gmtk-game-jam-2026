/**
 * Floor theme test.
 *
 * Every floor now has a shape rather than a scaled-up version of the same mix,
 * and the properties that make that read as design instead of noise are all
 * statistical or sequential — neither of which is visible in a screenshot or a
 * single run.
 *
 * Drives the real generator by importing it into the page (the dev server
 * serves the modules, so no new public API is needed just to test this) and
 * samples many seeds, because one run's rolls prove nothing about a
 * distribution.
 *
 * Usage:  npm run dev   (in one shell)
 *         node scripts/themes.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.FULLRUN_URL ?? 'http://127.0.0.1:5173';
const EXECUTABLE =
  process.env.SMOKE_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SEEDS = 400;
const MAX_DEPTH = 16;

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(`${BASE}/debug.html`, { waitUntil: 'networkidle' });

const survey = await page.evaluate(
  async ([seeds, maxDepth]) => {
    const { Floor } = await import('/src/game/Floor.ts');
    const { ThemeDirector, THEMES, REVEAL_FLOORS, FIRST_THEMED_DEPTH } = await import(
      '/src/game/Themes.ts'
    );
    const { Rand } = await import('/src/core/Rand.ts');

    const KIND = { number: 0, down: 1, up: 2, spent: 3, time: 4, boost: 5, freeze: 6 };
    const runs = [];

    for (let s = 0; s < seeds; s++) {
      const rand = new Rand(1000 + s * 7919);
      const themes = new ThemeDirector();
      const floors = [];
      for (let depth = 0; depth <= maxDepth; depth++) {
        const theme = themes.pick(depth, rand);
        const f = new Floor(depth, rand, 0, 0, theme);
        const counts = {};
        for (const t of f.tiles) counts[t.kind] = (counts[t.kind] ?? 0) + 1;
        floors.push({
          depth,
          theme,
          n: f.tiles.length,
          down: counts[KIND.down] ?? 0,
          number: counts[KIND.number] ?? 0,
          up: counts[KIND.up] ?? 0,
          time: counts[KIND.time] ?? 0,
          boost: counts[KIND.boost] ?? 0,
          freeze: counts[KIND.freeze] ?? 0,
        });
      }
      runs.push(floors);
    }

    return {
      runs,
      cooldowns: Object.fromEntries(
        Object.entries(THEMES).map(([k, v]) => [k, v.cooldown]),
      ),
      reveals: Object.fromEntries([...REVEAL_FLOORS.entries()]),
      firstThemedDepth: FIRST_THEMED_DEPTH,
    };
  },
  [SEEDS, MAX_DEPTH],
);

const all = survey.runs.flat();
const failures = [];
const results = {};

// --- exactly one way down, on every floor, always ---------------------------
const badDown = all.filter((f) => f.down !== 1);
results.floorsChecked = all.length;
if (badDown.length > 0) {
  const worst = badDown[0];
  failures.push(
    `${badDown.length} floor(s) did not have exactly one DOWN tile (e.g. depth ${worst.depth}: ${worst.down})`,
  );
}

// --- reveal floors reveal exactly one powerup, and actually have it ---------
results.reveals = {};
for (const [depthStr, theme] of Object.entries(survey.reveals)) {
  const depth = Number(depthStr);
  const kind = theme.replace('reveal', '').toLowerCase();
  const others = ['time', 'boost', 'freeze'].filter((k) => k !== kind);
  const floors = all.filter((f) => f.depth === depth);

  const wrongTheme = floors.filter((f) => f.theme !== theme).length;
  const empty = floors.filter((f) => f[kind] === 0).length;
  const contaminated = floors.filter((f) => others.some((o) => f[o] > 0)).length;
  results.reveals[theme] = {
    depth,
    min: Math.min(...floors.map((f) => f[kind])),
    mean: +(floors.reduce((a, f) => a + f[kind], 0) / floors.length).toFixed(1),
  };

  if (wrongTheme > 0) failures.push(`${wrongTheme} floor(s) at depth ${depth} were not ${theme}`);
  if (empty > 0) failures.push(`${empty} ${theme} floor(s) contained no ${kind} tile at all`);
  if (contaminated > 0) {
    failures.push(
      `${contaminated} ${theme} floor(s) also carried another powerup — the reveal has to be unambiguous`,
    );
  }
}

// --- no theme repeats inside its cooldown ----------------------------------
const violations = [];
for (const run of survey.runs) {
  const lastAt = {};
  for (const f of run) {
    const cd = survey.cooldowns[f.theme] ?? 0;
    if (cd > 0 && lastAt[f.theme] !== undefined && f.depth - lastAt[f.theme] <= cd) {
      violations.push(`${f.theme} at depth ${lastAt[f.theme]} then ${f.depth} (cooldown ${cd})`);
    }
    lastAt[f.theme] = f.depth;
  }
}
if (violations.length > 0) {
  failures.push(`${violations.length} cooldown violation(s), e.g. ${violations[0]}`);
}

// --- nothing themed before the teaching floors are done --------------------
const earlyThemed = all.filter(
  (f) => f.depth < survey.firstThemedDepth && !f.theme.startsWith('reveal') && f.theme !== 'default',
);
if (earlyThemed.length > 0) {
  failures.push(
    `${earlyThemed.length} themed floor(s) appeared before depth ${survey.firstThemedDepth}`,
  );
}

// --- the default mix is the one that was asked for -------------------------
// Roughly 40% numbers, 50% up, 10% powerups, past the opening ramp.
const defaults = all.filter((f) => f.theme === 'default' && f.depth >= 4);
const share = (key) =>
  defaults.reduce((a, f) => a + (Array.isArray(key) ? key.reduce((s, k) => s + f[k], 0) : f[key]), 0) /
  defaults.reduce((a, f) => a + f.n, 0);
results.defaultMix = {
  floors: defaults.length,
  number: +share('number').toFixed(3),
  up: +share('up').toFixed(3),
  powerup: +share(['time', 'boost', 'freeze']).toFixed(3),
};
const near = (actual, target, tol, label) => {
  if (Math.abs(actual - target) > tol) {
    failures.push(`default floors are ${(actual * 100).toFixed(0)}% ${label}, wanted ~${target * 100}%`);
  }
};
near(results.defaultMix.number, 0.4, 0.06, 'number tiles');
near(results.defaultMix.up, 0.5, 0.06, 'up tiles');
near(results.defaultMix.powerup, 0.1, 0.04, 'powerups');

// --- the opening is gentler than the steady state --------------------------
const opening = all.filter((f) => f.depth === 0);
results.openingUpShare = +(
  opening.reduce((a, f) => a + f.up, 0) / opening.reduce((a, f) => a + f.n, 0)
).toFixed(3);
if (results.openingUpShare > 0) {
  failures.push(`the first floor is ${(results.openingUpShare * 100).toFixed(0)}% hazards`);
}
const secondFloorUp =
  all.filter((f) => f.depth === 1).reduce((a, f) => a + f.up, 0) /
  all.filter((f) => f.depth === 1).reduce((a, f) => a + f.n, 0);
results.secondFloorUpShare = +secondFloorUp.toFixed(3);
if (secondFloorUp >= results.defaultMix.up * 0.8) {
  failures.push('the second floor is not easing into the hazard mix');
}

// --- powerups are introduced in order, never before their reveal ------------
//
// A named-kind theme still respects the unlock depths; only a reveal floor
// ignores them. Without that, a "high numbers" floor at depth 4 favours freeze
// and hands the player one three floors before the tip that explains it.
results.earliestSighting = {};
for (const [kind, revealDepth] of [
  ['time', 3],
  ['boost', 5],
  ['freeze', 7],
]) {
  const seen = all.filter((f) => f[kind] > 0);
  const earliest = seen.length > 0 ? Math.min(...seen.map((f) => f.depth)) : null;
  results.earliestSighting[kind] = earliest;
  if (earliest !== null && earliest < revealDepth) {
    failures.push(
      `${kind} tiles appeared at depth ${earliest}, before their reveal floor at ${revealDepth}`,
    );
  }
}

// --- the first floor cannot undo a landing ---------------------------------
const firstFloorHazards = all.filter((f) => f.depth === 0 && f.up > 0);
if (firstFloorHazards.length > 0) {
  failures.push(
    `${firstFloorHazards.length} of ${survey.runs.length} first floors spawned UP tiles`,
  );
}

// --- theme character: each one is actually distinct -------------------------
const themeShare = (theme, key) => {
  const f = all.filter((x) => x.theme === theme && x.depth >= 4);
  if (f.length === 0) return null;
  return (
    f.reduce((a, x) => a + (Array.isArray(key) ? key.reduce((s, k) => s + x[k], 0) : x[key]), 0) /
    f.reduce((a, x) => a + x.n, 0)
  );
};
results.themes = {};
for (const t of ['numbers', 'hazard', 'bounty']) {
  results.themes[t] = {
    count: all.filter((x) => x.theme === t).length,
    number: +(themeShare(t, 'number') ?? 0).toFixed(3),
    up: +(themeShare(t, 'up') ?? 0).toFixed(3),
    powerup: +(themeShare(t, ['time', 'boost', 'freeze']) ?? 0).toFixed(3),
    freeze: +(themeShare(t, 'freeze') ?? 0).toFixed(3),
  };
  if (results.themes[t].count === 0) failures.push(`the ${t} theme never appeared in ${SEEDS} runs`);
}

// A hazard floor must out-hazard the default, or it is not a theme.
if (results.themes.hazard.up <= results.defaultMix.up * 1.15) {
  failures.push(`hazard floors are only ${(results.themes.hazard.up * 100).toFixed(0)}% up tiles`);
}
// A numbers floor must be the safe one, and must carry the extra freeze.
if (results.themes.numbers.up >= results.defaultMix.up * 0.7) {
  failures.push('numbers floors are not meaningfully safer than the default');
}
if (results.themes.numbers.freeze <= results.defaultMix.powerup * 0.25) {
  failures.push('numbers floors are not carrying the extra freeze tiles they are meant to');
}
// A bounty floor is the powerup floor, and never freeze.
if (results.themes.bounty.powerup <= results.defaultMix.powerup * 2) {
  failures.push('bounty floors do not carry noticeably more powerups');
}
const bountyFreeze = all.filter((f) => f.theme === 'bounty' && f.freeze > 0).length;
if (bountyFreeze > 0) failures.push(`${bountyFreeze} bounty floor(s) spawned freeze tiles`);

console.log(JSON.stringify({ results, failures, pageErrors }, null, 1));

await browser.close();
if (failures.length > 0 || pageErrors.length > 0) {
  console.error(`\nFAIL: ${failures.join('; ')}\n`);
  process.exit(1);
}
console.error('\nPASS: one way down, reveals land, cooldowns hold, themes are distinct.\n');
