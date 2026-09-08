/** dsh_tui command: /memory — one command per file (self-registering,
 *  wired by the commands module index). */
import { t } from '../../kernel/i18n.js';
import { existsSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
/** /memory [delete <id>] — list / delete project memory files. */
export const memoryCommand = (app, a) => {
    const dir = join(process.cwd(), '.dsh', 'memory');
    const a0 = a ?? '';
    try {
        if (a0.startsWith('delete ')) {
            const target = a0.slice(7).trim();
            const file = join(dir, target.endsWith('.md') ? target : `${target}.md`);
            if (!existsSync(file)) {
                app.notice(`不存在: ${target}`);
                return;
            }
            unlinkSync(file);
            app.notice(`已删除 ${target}`);
            return;
        }
        if (!existsSync(dir)) {
            app.notice(t('（无项目记忆）用法: /remember <text> 写入'));
            return;
        }
        for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
            app.notice(`- ${f}`);
        }
    }
    catch (err) {
        app.notice(`memory 失败: ${err.message}`);
    }
};
export function installMemoryCommand(app) {
    app.registerCommands([{ name: '/memory', desc: t('浏览/删除项目记忆'), usage: t('[delete <id>]'), group: t('记忆'), fn: (a) => memoryCommand(app, a) }]);
}
