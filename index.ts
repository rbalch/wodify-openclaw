import { getClassesTool, bookClassTool, checkAccessTool } from './src/tools.js';

interface OpenClawPluginApi {
  registerTool(tool: unknown, opts?: { optional?: boolean; name?: string }): void;
}

export default function register(api: OpenClawPluginApi): void {
  api.registerTool(getClassesTool, { optional: true });
  api.registerTool(bookClassTool, { optional: true });
  api.registerTool(checkAccessTool, { optional: true });
}
