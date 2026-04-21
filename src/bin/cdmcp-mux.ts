#!/usr/bin/env node
import {runShim} from '../shim/shim.js';
import {runDaemon} from '../daemon/daemon.js';
import {runStatus} from '../cli/status.js';
import {runTail} from '../cli/tail.js';

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case 'shim':
      await runShim();
      break;
    case 'daemon':
      await runDaemon();
      break;
    case 'status':
      await runStatus();
      break;
    case 'tail':
      await runTail(rest);
      break;
    case '--help':
    case '-h':
      console.log(
        [
          'Usage:',
          '  cdmcp-mux            Run as MCP stdio shim (default; for .mcp.json)',
          '  cdmcp-mux daemon     Run the shared daemon (auto-spawned when needed)',
          '  cdmcp-mux status     Print daemon + contexts snapshot',
          '  cdmcp-mux tail [-f]  Stream the mux log',
        ].join('\n'),
      );
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
