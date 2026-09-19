/**
 * Headless milestone gate runner: `npm run gate` from the repo root.
 *
 * The same scenarios the development room runs from Modules, minus the device. Every
 * failure this catches is one that would otherwise need a build, a cable and a phone,
 * and the suite is pure TypeScript precisely so it does not need any of them.
 *
 * Exits non-zero on any failure so CI can depend on it. This is a runner, not a test
 * framework: the migration plan rules a testing workstream out of scope.
 */
import { checkDeterminism, runScenario, scenarios, type ScenarioResult } from './scenarios';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

async function main() {
  const only = process.argv[2]?.toUpperCase();
  const selected = only ? scenarios.filter((s) => s.milestone === only) : scenarios;
  if (!selected.length) {
    console.error(`No scenarios for "${only ?? 'all'}". Known: ${[...new Set(scenarios.map(s => s.milestone))].join(', ')}.`);
    process.exit(2);
  }

  const results: ScenarioResult[] = [];
  let milestone = '';
  for (const scenario of selected) {
    if (scenario.milestone !== milestone) {
      milestone = scenario.milestone;
      console.log(`\n${milestone} gate`);
    }
    const started = Date.now();
    const result = await runScenario(scenario);
    results.push(result);
    console.log(
      `  ${result.ok ? `${GREEN}PASS${OFF}` : `${RED}FAIL${OFF}`} ${result.title} ${DIM}(${Date.now() - started}ms)${OFF}`,
    );
    for (const step of result.steps)
      console.log(`      ${step.ok ? `${GREEN}ok${OFF}` : `${RED}NO${OFF}`} ${step.label} ${DIM}- ${step.detail}${OFF}`);
  }

  // Same output twice is the only proof that a solver result was reasoned, not sampled.
  console.log('\nDeterminism');
  for (const id of ['overlap', 'carry-adjust', 'calib-inferred', 'input-ordering', 'plan-deterministic']) {
    const scenario = selected.find((s) => s.id === id);
    if (!scenario) continue;
    const repeat = await checkDeterminism(scenario);
    results.push({ id: `determinism-${id}`, title: repeat.label, steps: [repeat], ok: repeat.ok });
    console.log(`  ${repeat.ok ? `${GREEN}PASS${OFF}` : `${RED}FAIL${OFF}`} ${repeat.label} ${DIM}- ${repeat.detail}${OFF}`);
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

void main();
