import { Command } from 'commander';

/**
 * `handsoff` entry point. Commands are wired to the engines in later phases:
 * discover (P2), replay (P1/P3), serve (P3). See docs/context/04-roadmap.md.
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
  .description('Run an LLM-driven discovery for a goal against a target application')
  .requiredOption('--goal <text>', 'the goal in natural language')
  .option('--param <name=value...>', 'typed parameter values', collect, [])
  .option('--target <vendorProductId>', 'app profile id', 'acme-coreteller')
  .action(() => {
    console.error('discover is not built yet (phase P2).');
    process.exitCode = 2;
  });

program
  .command('replay')
  .description('Replay a saved capability with parameters, without the LLM')
  .requiredOption('--capability <id>', 'capability id')
  .option('--version <n>', 'capability version, default latest')
  .option('--param <name=value...>', 'parameter values', collect, [])
  .option('--chaos <modes>', 'comma-separated chaos modes for the mock app')
  .action(() => {
    console.error('replay is not built yet (phase P1).');
    process.exitCode = 2;
  });

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

program.parse();
