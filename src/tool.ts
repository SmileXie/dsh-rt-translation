/** Model-callable entry point mirroring the slash commands. */
import type { CommandTarget } from './commands.ts'

export interface ToolRegistry { register(definition: unknown): () => void }

/**
 * Register `rt_translate` so the agent can start/stop subtitles on request.
 * The definition is authored as a raw ToolDefinition: this plugin lives
 * outside the harness workspace, so importing `defineTool` at runtime would
 * not resolve from here. The registry validates `output` itself.
 */
export function registerTool(registry: ToolRegistry, controller: CommandTarget): void {
  registry.register({
    name: 'rt_translate',
    description: 'Control the realtime speech translation subtitles. action=start|stop|status; optional source/target language codes (auto, zh, en, ja, ko, yue).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'What to do with the subtitle session.' },
        source: { type: 'string', description: 'Source language code: auto, zh, en, ja, ko, yue.' },
        target: { type: 'string', description: 'Target language code: zh, en, ja, ko, yue.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: unknown): Promise<string> {
      const record = (args ?? {}) as { action?: string; source?: string; target?: string }
      if (record.source !== undefined && record.target !== undefined) {
        await controller.setLanguages(record.source as never, record.target as never)
      }
      if (record.action === 'start') { await controller.start(); return '字幕已开始' }
      if (record.action === 'stop') { await controller.stop(); return '字幕已停止' }
      return controller.status()
    },
  })
}
