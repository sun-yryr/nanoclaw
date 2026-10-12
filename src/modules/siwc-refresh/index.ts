/**
 * Host module: keep the Cline SIWC vault access token fresh via refresh_token.
 */
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { startSiwcRefreshLoop, type SiwcRefreshLoopHandle } from './loop.js';

export {
  refreshSiwcSessionIfNeeded,
  sessionFromLogin,
  exchangeRefreshToken,
  type SiwcRefreshResult,
} from './refresh.js';
export {
  loadSiwcSession,
  saveSiwcSession,
  clearSiwcSession,
  resolveSiwcSessionPath,
  type SiwcSession,
} from './session.js';
export {
  CLINE_SIWC_CONNECTION_NAME,
  CLINE_SIWC_HOST,
  CLINE_SIWC_PROXY_VALUE,
  CLINE_SIWC_SHARING_SCOPE,
  CLINE_SIWC_TOKEN_ENDPOINT,
  CLINE_SIWC_RESOURCE,
  CLINE_SIWC_MODEL_BASE,
  accessTokenFromSiwcTokens,
  saveSiwcAccessToVault,
  scopesIncludeSharing,
} from './vault.js';
export { startSiwcRefreshLoop, SIWC_REFRESH_CHECK_MS } from './loop.js';

let loop: SiwcRefreshLoopHandle | undefined;

onHostStart(({ signal }) => {
  loop = startSiwcRefreshLoop({ signal });
});

onHostShutdown(() => {
  loop?.stop();
  loop = undefined;
});
