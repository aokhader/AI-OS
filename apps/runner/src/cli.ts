import { Command } from 'commander';
import { runDiscoverCommand } from './commands/discover.js';
import { runReplayCommand } from './commands/replay.js';

/**
 * `handsoff` entry point. discover (P2) and replay (P1) are live; serve (P3) follows.
 * See docs/context/04-roadmap.md.
 */
const program = new Command();

program
  .name('handsoff')
  .description(
    'Discover once with an LLM, replay deterministically, escalate to a human when stuck.',
  )
  .version('0.1.0');

program
  .command('discover')
  .description('Run an LLM-driven discovery for a goal and compile the result into a capability')
  .requiredOption('--goal <text>', 'the goal in natural language')
  .option('--param <name=value>', 'parameter value used during discovery (repeatable)', collect, [])
  .option('--sensitive <name>', 'mark a parameter as sensitive (repeatable)', collect, [])
  .option('--describe <name=text>', 'description of a parameter (repeatable)', collect, [])
  .option('--outcome <CODE=text>', 'business outcome: code and the page text that signals it (repeatable)', collect, [])
  .option('--id <capabilityId>', 'capability id (default: derived from the goal)')
  .option('--name <text>', 'capability name (default: the goal)')
  .option('--target <vendorProductId>', 'app profile id', 'acme-coreteller')
  .option('--entry <route>', 'route to open after sign-in', '/')
  .option('--variant <variantId>', 'variant the recording is made on')
  .option('--base-url <url>', 'origin of the target app (default HANDSOFF_TARGET_URL or http://localhost:4100)')
  .option('--headless', 'run the browser headless (default HANDSOFF_HEADLESS)')
  .option('--max-steps <n>', 'turn limit (default HANDSOFF_MAX_STEPS or 30)')
  .option('--model <id>', 'model id (default HANDSOFF_MODEL or claude-opus-5)')
  .option('--effort <level>', 'low | medium | high | xhigh | max (default HANDSOFF_EFFORT or high)')
  .option('--scripted <file>', 'follow a JSON script instead of calling a model (offline demo, tests)')
  .option('--data-dir <dir>', 'data directory (default HANDSOFF_DATA_DIR or ./data)')
  .action(
    async (opts: {
      goal: string;
      param: string[];
      sensitive: string[];
      describe: string[];
      outcome: string[];
      id?: string;
      name?: string;
      target: string;
      entry?: string;
      variant?: string;
      baseUrl?: string;
      headless?: boolean;
      maxSteps?: string;
      model?: string;
      effort?: string;
      scripted?: string;
      dataDir?: string;
    }) => {
      process.exitCode = await runDiscoverCommand(opts);
    },
  );

program
  .command('replay')
  .description('Replay a saved capability with parameters, without the LLM')
  .requiredOption('--capability <id>', 'capability id')
  .option('--version <n>', 'capability version, default latest')
  .option('--param <name=value>', 'parameter value (repeatable)', collect, [])
  .option('--base-url <url>', 'origin of the target app (default HANDSOFF_TARGET_URL or http://localhost:4100)')
  .option('--chaos <modes>', 'comma-separated chaos modes for the mock app')
  .option('--headless', 'run the browser headless (default HANDSOFF_HEADLESS)')
  .option('--data-dir <dir>', 'data directory (default HANDSOFF_DATA_DIR or ./data)')
  .action(
    async (opts: {
      capability: string;
      version?: string;
      param: string[];
      baseUrl?: string;
      chaos?: string;
      headless?: boolean;
      dataDir?: string;
    }) => {
      process.exitCode = await runReplayCommand(opts);
    },
  );

program
  .command('serve')
  .description('Start the API and operator console without running anything')
  .action(() => {
    console.error('serve is not built yet (phase P3).');
    process.exitCode = 2;
  });

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
