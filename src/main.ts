import { loadConfig, ConfigurationError } from './configuration/load.js';
import { composeApplication, StartupError } from './bootstrap/compose.js';

async function main(): Promise<void> {
  try {
    const config = loadConfig({
      ...(process.env.CODERAX_ENGINE_CONFIG ? { filePath: process.env.CODERAX_ENGINE_CONFIG } : {}),
    });
    const app = await composeApplication({ config });
    const { url } = await app.start();

    const shutdown = async (): Promise<void> => {
      await app.stop();
      process.exit(0);
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());

    process.stdout.write(`coderax-workflow-engine listening on ${url}\n`);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`configuration invalid:\n${error.issues.map((i) => `- ${i}`).join('\n')}\n`);
      process.exit(2);
    }
    if (error instanceof StartupError) {
      process.stderr.write(`startup blocked:\n${error.issues.map((i) => `- ${i}`).join('\n')}\n`);
      process.exit(3);
    }
    throw error;
  }
}

await main();
