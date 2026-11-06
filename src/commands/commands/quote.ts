/** dsh_tui command: /quote — turn the chat selection (or current line) into a
 *  Markdown quote in the composer. Visual selection marks are buffer-local, so
 *  the Lua facade reads them before focus returns to the input. */
import { t, tf } from '../../kernel/i18n.js'
import type { App } from '../../kernel/app.js'

export const quoteCommand = async (app: App): Promise<void> => {
  const count = await app.luaCall('require("dsh_tui").quote_selection()').catch(() => 0)
  if (typeof count !== 'number' || count <= 0) {
    app.notice(t('没有可引用的文本：先在聊天区选中几行，或把光标停在要引用的行上'))
    return
  }
  app.notice(tf('已插入 {0} 行引用；可继续编辑后发送', [String(count)]))
}

export function installQuoteCommand(app: App): void {
  app.registerCommands([{
    name: '/quote',
    desc: t('把聊天区选中/当前行作为引用插入输入框'),
    usage: t(''),
    group: t('会话'),
    fn: () => quoteCommand(app),
  }])
}
