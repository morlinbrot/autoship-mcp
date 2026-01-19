#!/usr/bin/env node

import { run as init } from "./init.js";

const commands: Record<string, (args: string[]) => Promise<void>> = {
  init,
};

function printHelp(): void {
  console.log(`
autoship - CLI for @autoship/react

Usage:
  npx autoship <command> [options]

Commands:
  init    Initialize Autoship database schema

Options:
  -h, --help    Show this help message

Run 'npx autoship <command> --help' for more information on a command.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "-h" || command === "--help") {
    printHelp();
    process.exit(0);
  }

  const commandFn = commands[command];

  if (!commandFn) {
    console.error(`\n  Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  await commandFn(args.slice(1));
}

main();
