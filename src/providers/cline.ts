/**
 * Cline provider container config — registered when the user has configured
 * an OpenAI-compatible endpoint via setup.
 *
 * The real auth token never enters the container. Setup creates a OneCLI
 * generic secret (host-pattern = base URL hostname, header-name =
 * Authorization, value-format = "Bearer {value}") so the proxy rewrites the
 * Authorization header on the wire. The container only needs:
 *   - CLINE_BASE_URL — so the SDK knows where to call
 *   - OPENCODE_GO_API_KEY=placeholder — so the SDK adds an
 *     Authorization: Bearer header for OneCLI to overwrite
 *
 * SIWC mode (CLINE_AUTH_MODE=siwc): gateway vault "Cline SIWC" rewrites
 * Authorization for api.openai.com. Host injects base URL + sentinel key;
 * container forces openai-native and strips SIWC-forbidden Responses fields.
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const CLINE_SIWC_BASE_URL = 'https://api.openai.com/v1';
const CLINE_SIWC_SENTINEL = 'siwc-sentinel';

registerProviderContainerConfig('cline', () => {
  const dotenv = readEnvFile([
    'CLINE_AUTH_MODE',
    'CLINE_BASE_URL',
    'CLINE_MODEL',
    'CLINE_API',
    'CLINE_REASONING_EFFORT',
    'CLINE_TRANSCRIPT_MAX_TOKENS',
    'CLINE_SPAWN_MODEL',
    'CLINE_SPAWN_API',
    'CLINE_SPAWN_BASE_URL',
    'CLINE_SPAWN_AUTH_MODE',
    'CLINE_SPAWN_MAX_ITERATIONS',
    'OPENCODE_MODEL',
    'MOONSHOT_API_BASE_URL',
    'MOONSHOT_API_KEY',
  ]);
  const env: Record<string, string> = {};
  const authMode = (dotenv.CLINE_AUTH_MODE ?? '').trim().toLowerCase();
  const siwc = authMode === 'siwc';

  if (dotenv.CLINE_AUTH_MODE) {
    env.CLINE_AUTH_MODE = dotenv.CLINE_AUTH_MODE;
  }

  if (siwc) {
    env.CLINE_AUTH_MODE = 'siwc';
    env.CLINE_BASE_URL = dotenv.CLINE_BASE_URL?.trim() || CLINE_SIWC_BASE_URL;
    env.CLINE_API = 'responses';
    // Sentinel only — gateway overwrites Authorization from the Cline SIWC vault.
    env.OPENCODE_GO_API_KEY = CLINE_SIWC_SENTINEL;
  } else if (dotenv.CLINE_BASE_URL) {
    env.CLINE_BASE_URL = dotenv.CLINE_BASE_URL;
    // Placeholder so the SDK adds an Authorization header; OneCLI overwrites it.
    env.OPENCODE_GO_API_KEY = 'placeholder';
  }

  if (dotenv.CLINE_MODEL) {
    env.CLINE_MODEL = dotenv.CLINE_MODEL;
  }
  if (!siwc && dotenv.CLINE_API) {
    env.CLINE_API = dotenv.CLINE_API;
  }
  if (dotenv.CLINE_REASONING_EFFORT) {
    env.CLINE_REASONING_EFFORT = dotenv.CLINE_REASONING_EFFORT;
  }
  if (dotenv.CLINE_TRANSCRIPT_MAX_TOKENS) {
    env.CLINE_TRANSCRIPT_MAX_TOKENS = dotenv.CLINE_TRANSCRIPT_MAX_TOKENS;
  }
  if (dotenv.CLINE_SPAWN_MODEL) {
    env.CLINE_SPAWN_MODEL = dotenv.CLINE_SPAWN_MODEL;
  }
  if (dotenv.CLINE_SPAWN_API) {
    env.CLINE_SPAWN_API = dotenv.CLINE_SPAWN_API;
  }
  if (dotenv.CLINE_SPAWN_BASE_URL) {
    env.CLINE_SPAWN_BASE_URL = dotenv.CLINE_SPAWN_BASE_URL;
    // Child may hit a different host than the parent; still need a Bearer
    // placeholder so OneCLI can rewrite Authorization for that hostname.
    env.OPENCODE_GO_API_KEY = env.OPENCODE_GO_API_KEY || 'placeholder';
  }
  if (dotenv.CLINE_SPAWN_AUTH_MODE) {
    env.CLINE_SPAWN_AUTH_MODE = dotenv.CLINE_SPAWN_AUTH_MODE;
  }
  if (dotenv.CLINE_SPAWN_MAX_ITERATIONS) {
    env.CLINE_SPAWN_MAX_ITERATIONS = dotenv.CLINE_SPAWN_MAX_ITERATIONS;
  }
  if (!siwc && dotenv.OPENCODE_MODEL) {
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
