/** Browser review fixture using the production hosts and stores. No notebook files are written. */
import { createRoot } from 'react-dom/client';
import '@/styles/index.css';
import { I18nProvider } from '@/lib/i18n';
import { CreatedDocumentNoticeHost } from '@/app/created-document-notice-host';
import { clearCreatedDocumentNotices, notifyCreatedDocument } from '@/app/created-document-notices';
import { ActionableNoticeHost } from '@features/notifications/actionable-notice-host';
import { clearActionableNotice, upsertActionableNotice } from '@features/notifications/actionable-notice-store';

function seed(count: number) {
  clearCreatedDocumentNotices();
  for (let index = 0; index < count; index++) {
    notifyCreatedDocument(`/review/项目资料/文档-${index}.md`, '/review', 'review');
  }
}
function conflict() {
  upsertActionableNotice({
    id: 'review-conflict', priority: 100, tone: 'warning', title: '文档保存冲突',
    message: '浏览器验证场景：不会读写真实文件。',
    actions: ['使用磁盘版本', '保留编辑版本'].map((label, index) => ({
      id: String(index), label, run: () => clearActionableNotice('review-conflict'),
    })),
  });
}

function Review() {
  return <main className="min-h-screen bg-[var(--background)] p-8 text-[var(--foreground)]">
    <h1 className="mb-4 text-lg">新文档通知交互验证</h1>
    <div className="flex gap-4">
      <button onClick={() => seed(1)}>单张通知</button>
      <button onClick={() => seed(45)}>45 张通知</button>
      <button onClick={conflict}>显示冲突提示</button>
      <button onClick={clearCreatedDocumentNotices}>清空测试通知</button>
    </div>
    <input aria-label="外部焦点" className="mt-4 border p-2" placeholder="用于验证焦点离开" />
    <CreatedDocumentNoticeHost />
    <ActionableNoticeHost />
  </main>;
}

createRoot(document.getElementById('root')!).render(<I18nProvider language="zh-CN"><Review /></I18nProvider>);
