import { homedir } from 'os'
import { join } from 'path'

export const KIMI_WEBBRIDGE_TOOL_NAME = 'kimi_webbridge'
export const DAEMON_PORT = 10086
export const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`
export const DAEMON_INSTALL_DIR = join(homedir(), '.kimi-webbridge')
export const DAEMON_BIN_DIR = join(DAEMON_INSTALL_DIR, 'bin')
export const DAEMON_BIN = join(
  DAEMON_BIN_DIR,
  process.platform === 'win32' ? 'kimi-webbridge.exe' : 'kimi-webbridge',
)
/** Official bootstrap installer (daemon binary + skill install). */
export const INSTALL_SCRIPT_URL = 'https://cdn.kimi.com/webbridge/install.sh'
export const HELP_PAGE_EN = 'https://www.kimi.com/features/webbridge'
export const HELP_PAGE_ZH = 'https://www.kimi.com/zh-cn/features/webbridge'
/** Chrome / Edge extension id, used for the store link in error hints. */
export const EXTENSION_ID = 'fldmhceldgbpfpkbgopacenieobmligc'
export const EXTENSION_STORE_URL =
  'https://chromewebstore.google.com/detail/kimi-webbridge/' + EXTENSION_ID
/** Cap on a single tool result rendered back into the model context. */
export const MAX_RESULT_CHARS = 200_000
