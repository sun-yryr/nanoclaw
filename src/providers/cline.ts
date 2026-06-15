/**
 * Cline provider container config — registered when the user has configured
 * an OpenAI-compatible endpoint via setup.
 *
 * The real auth token never enters the container. Setup creates a OneCLI
 * generic secret (host-pattern = base URL hostname, header-name =
 * Authorization, value-format = "Bearer {value}") so the proxy rewrites the
 * Authorization header on the wire. The container only needs:
 *   - ANTHROPIC_BASE_URL — so the SDK knows where to call
 *   - OPENCODE_GO_API_KEY=placeholder — so the SDK adds an
 *     Authorization: Bearer header for OneCLI to overwrite
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('cline', () => {
  const dotenv = readEnvFile([
    'ANTHROPIC_BASE_URL',
    'CLINE_MODEL',
    'OPENCODE_MODEL',
    'MOONSHOT_API_BASE_URL',
    'MOONSHOT_API_KEY',
  ]);
  const env: Record<string, string> = {};
  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    // Placeholder so the SDK adds an Authorization header; OneCLI overwrites it.
    env.OPENCODE_GO_API_KEY = 'placeholder';
  }
  if (dotenv.CLINE_MODEL) {
    env.CLINE_MODEL = dotenv.CLINE_MODEL;
  }
  if (dotenv.OPENCODE_MODEL) {
    env.OPENCODE_MODEL = dotenv.OPENCODE_MODEL;
  }
  // Moonshot Files API for video uploads (OpenCode Go has no /files proxy).
  if (dotenv.MOONSHOT_API_BASE_URL) {
    env.MOONSHOT_API_BASE_URL = dotenv.MOONSHOT_API_BASE_URL;
  }
  if (dotenv.MOONSHOT_API_KEY) {
    env.MOONSHOT_API_KEY = dotenv.MOONSHOT_API_KEY;
  }
  return { env };
});
