import { updateReasonLibrary } from './storage';

const defaults = ['错别字', '语法错误', '语义不准确', '表达不自然', '漏译', '逻辑问题', '表记不统一'];
const reasonKey = (text) => text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();

export function createReasonLibrary(byId, action) {
  const search = byId('reason-search');
  const manage = byId('reason-manage');
  const options = byId('reason-options');
  const editor = byId('reason-editor');
  const input = byId('reason-value');
  const save = byId('reason-store');
  const cancel = byId('reason-cancel');
  const status = byId('reason-status');
  let entries = [];
  let editingKey = null;
  let updates = Promise.resolve();
  const selected = new Set();

  function message(text = '') {
    status.hidden = !text;
    status.textContent = text;
  }

  function render() {
    const query = reasonKey(search.value);
    options.replaceChildren();
    for (const entry of entries) {
      if (!entry.key.includes(query)) continue;
      const row = document.createElement('div');
      row.className = 'reason-row';
      const choose = action(entry.text, () => {
        const comment = byId('comment-text');
        const previous = comment.value;
        if (!previous.trim()) comment.value = entry.text;
        else if (!('\n' + previous + '\n').includes('\n' + entry.text + '\n')) {
          const combined = previous + (previous.endsWith('\n') ? '' : '\n') + entry.text;
          if (combined.length > comment.maxLength) return message('批注内容超过长度上限。');
          comment.value = combined;
        }
        selected.add(entry.key);
        comment.focus();
        comment.setSelectionRange(comment.value.length, comment.value.length);
      });
      choose.className = 'reason-choice';
      choose.title = entry.text;
      row.append(choose);
      if (!editor.hidden) {
        row.append(action('编辑', () => {
          editingKey = entry.key;
          input.value = entry.text;
          save.textContent = '保存理由';
          cancel.hidden = false;
          input.focus();
        }), action('删除', async () => {
          if (await change((library) => {
            library.delete(entry.key);
            library.set(entry.key, { key: entry.key, deleted: true });
          })) {
            if (editingKey === entry.key) resetEditor();
            message('已删除理由。');
          }
        }));
      }
      options.append(row);
    }
    if (!options.childElementCount) options.textContent = '未找到理由';
  }

  function resetEditor() {
    editingKey = null;
    input.value = '';
    save.textContent = '添加理由';
    cancel.hidden = true;
  }

  function change(edit) {
    updates = updates.then(async () => {
      try {
        const stored = await updateReasonLibrary((existing = defaults.map((text) => ({
          key: reasonKey(text), text, usedAt: 0,
        }))) => {
          const library = new Map(existing.map((entry) => [entry.key, entry]));
          edit(library);
          return [...library.values()];
        });
        entries = stored.filter((entry) => !entry.deleted).sort((a, b) => b.usedAt - a.usedAt);
        render();
        return true;
      } catch {
        message('理由库保存失败，请重试。');
        return false;
      }
    });
    return updates;
  }

  search.addEventListener('input', render);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) event.preventDefault();
  });
  manage.addEventListener('click', () => {
    editor.hidden = !editor.hidden;
    manage.setAttribute('aria-pressed', String(!editor.hidden));
    resetEditor();
    message();
    render();
  });
  cancel.addEventListener('click', resetEditor);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      save.click();
    }
  });
  save.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) return message('请输入理由。');
    const key = reasonKey(text);
    const previous = editingKey;
    if (await change((library) => {
      if (previous && previous !== key) library.set(previous, { key: previous, deleted: true });
      library.set(key, { key, text, usedAt: Date.now() });
    })) {
      resetEditor();
      search.value = '';
      message('已保存理由。');
      render();
    }
  });

  return {
    reset() {
      selected.clear();
      search.value = '';
      editor.hidden = true;
      manage.setAttribute('aria-pressed', 'false');
      message();
      resetEditor();
      render();
    },
    importProjects(projects) {
      return change((library) => {
        for (const project of projects) for (const round of project.rounds) {
          for (const annotation of round.annotations) {
            const text = (annotation.comment ?? '').trim();
            const key = reasonKey(text);
            const usedAt = Date.parse(annotation.createdAt) || 0;
            const prior = library.get(key);
            if (key && !prior?.deleted && (!prior || prior.usedAt < usedAt)) library.set(key, { key, text, usedAt });
          }
        }
      });
    },
    remember(text) {
      const used = [...selected];
      return change((library) => {
        const key = reasonKey(text);
        for (const choice of used) {
          const entry = library.get(choice);
          if (entry && !entry.deleted) entry.usedAt = Date.now() - 1;
        }
        library.set(key, { key, text, usedAt: Date.now() });
      });
    },
  };
}
