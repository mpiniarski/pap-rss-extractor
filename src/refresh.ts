import { fileURLToPath } from "node:url";
import {
  DEFAULT_CONFIG_PATH,
  loadDotEnvLocal,
  loadFeedConfig,
  writeMergedFeed
} from "./pap-rss.js";

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

function parseArgs(args: string[]): { configPath: string; watch: boolean } {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    watch: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--config") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("Opcja --config wymaga wartosci.");
      }
      options.configPath = value;
      index += 1;
      continue;
    }

    if (arg === "--watch") {
      options.watch = true;
      continue;
    }

    throw new Error(`Nieznana opcja: ${arg}`);
  }

  return options;
}

async function refreshOnce(configPath: string): Promise<void> {
  const config = await loadFeedConfig(configPath);
  await writeMergedFeed(config);
}

async function main(): Promise<void> {
  await loadDotEnvLocal();
  const options = parseArgs(process.argv.slice(2));

  await refreshOnce(options.configPath);

  if (!options.watch) {
    return;
  }

  process.stderr.write("Odswiezanie co 1 godzine.\n");
  setInterval(() => {
    refreshOnce(options.configPath).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Blad odswiezania: ${message}\n`);
    });
  }, REFRESH_INTERVAL_MS);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Blad: ${message}\n`);
    process.exitCode = 1;
  });
}
