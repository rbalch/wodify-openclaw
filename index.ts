import { getClassesTool, bookClassTool, checkAccessTool, setPluginConfig } from './src/tools.js';
import type { WodifyPluginConfig } from './src/types.js';

interface OpenClawPluginApi {
  pluginConfig?: Record<string, unknown>;
  registerTool(tool: unknown, opts?: { optional?: boolean; name?: string }): void;
}

export default function register(api: OpenClawPluginApi): void {
  // Inject config from openclaw.json → plugins.entries.wodify.config
  if (api.pluginConfig) {
    setPluginConfig(api.pluginConfig as unknown as WodifyPluginConfig);
  }

  api.registerTool(getClassesTool, { optional: true });
  api.registerTool(bookClassTool, { optional: true });
  api.registerTool(checkAccessTool, { optional: true });
}
