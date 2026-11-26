import { createStore, get, getMany, keys, set, setMany } from 'idb-keyval';
import { strFromU8, strToU8, unzip, zip } from 'fflate';

const store = createStore('docx-review-engine-prototype', 'review');
const projectPrefix = 'project:';
const filePrefix = 'file:';
const key = (id) => projectPrefix + id;
const backupLimit = 384 * 1024 * 1024;
const fileLimit = 25 * 1024 * 1024;
const validHash = (hash) => /^[a-f0-9]{64}$/.test(hash);

export async function fingerprint(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function stageFile(file) {
  if (!file || file.size === 0 || file.size > fileLimit) throw new Error('文件为空或超过单文件 25 MB 限制。');
  const hash = await fingerprint(await file.arrayBuffer());
  return { ref: { hash, name: file.name, type: file.type }, file };
}

function fileEntries(staged) {
  return staged.filter(Boolean).map(({ ref, file }) => [filePrefix + ref.hash, file]);
}

export async function getFile(ref) {
  if (!ref) return null;
  const file = await get(filePrefix + ref.hash, store);
  if (!(file instanceof Blob)) throw new Error('本地副本缺失：' + ref.name);
  return new File([file], ref.name, { type: ref.type });
}

export async function listProjects() {
  const ids = (await keys(store)).filter((name) => typeof name === 'string' && name.startsWith(projectPrefix));
  const projects = await getMany(ids, store);
  return projects.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export const getProject = (id) => get(key(id), store);
export const getActive = () => get('active', store);
export const setActive = (projectId, roundId) => set('active', { projectId, roundId }, store);
export const getLegacy = () => get('current', store);
export const wasMigrated = () => get('legacy-migrated', store);

export function createProject(name, original, round) {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), name, original, rounds: [round], updatedAt: now, createdAt: now, version: 1 };
}

export async function saveNewProject(project, staged, migration = false) {
  const items = [[key(project.id), project], ...fileEntries(staged),
    ['active', { projectId: project.id, roundId: project.rounds.at(-1).id }]];
  if (migration) items.push(['legacy-migrated', true]);
  await setMany(items, store);
}

export async function saveRound(projectId, round, expectedVersion, staged = [], append = false) {
  return store('readwrite', (bucket) => new Promise((resolve, reject) => {
    const request = bucket.get(key(projectId));
    const transaction = bucket.transaction;
    let saved;
    transaction.oncomplete = () => resolve(saved);
    transaction.onabort = () => reject(transaction.error ?? new Error('本地事务未能保存。'));
    request.onsuccess = () => {
      try {
        const latest = request.result;
        if (!latest || latest.version !== expectedVersion) {
          throw new Error('此项目已在另一页面更新。请重新打开项目后再试。');
        }
        if (!append && !latest.rounds.some((item) => item.id === round.id)) throw new Error('校对轮次不存在。');
        const rounds = append ? [...latest.rounds, round] : latest.rounds.map((item) => item.id === round.id ? round : item);
        saved = { ...latest, rounds, updatedAt: new Date().toISOString(), version: latest.version + 1 };
        for (const [name, value] of fileEntries(staged)) bucket.put(value, name);
        bucket.put(saved, key(projectId));
        if (append) bucket.put({ projectId, roundId: round.id }, 'active');
      } catch (error) {
        reject(error);
        transaction.abort();
      }
    };
  }));
}

function refsOf(project) {
  const refs = [project.original];
  for (const round of project.rounds) refs.push(round.base, round.revised, round.notes);
  return [...new Map(refs.filter(Boolean).map((ref) => [ref.hash, ref])).values()];
}

const archive = (entries) => new Promise((resolve, reject) =>
  zip(entries, { level: 0 }, (error, result) => error ? reject(error) : resolve(result)));

export async function exportProject(project) {
  const entries = { 'project.json': strToU8(JSON.stringify({ format: 'docx-review-project', version: 1, project })) };
  let size = entries['project.json'].byteLength;
  for (const ref of refsOf(project)) {
    const file = await getFile(ref);
    size += file.size;
    if (size > backupLimit) throw new Error('备份超过 384 MB，无法在浏览器内打包。');
    entries['files/' + ref.hash] = new Uint8Array(await file.arrayBuffer());
  }
  return new Blob([await archive(entries)], { type: 'application/zip' });
}

const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string';
const refValid = (ref) => object(ref) && text(ref.hash) && validHash(ref.hash) && text(ref.name) && text(ref.type);

function validate(project) {
  if (!object(project) || !text(project.id) || !text(project.name) || !refValid(project.original) ||
      !Array.isArray(project.rounds) || !project.rounds.length) throw new Error('备份缺少项目和原始文档信息。');
  const ids = new Set();
  for (const [index, round] of project.rounds.entries()) {
    if (!object(round) || !text(round.id) || ids.has(round.id) || !text(round.createdAt) ||
        !refValid(round.base) || !refValid(round.revised) || (round.notes && !refValid(round.notes)) ||
        round.order !== index + 1 || !Number.isInteger(round.nextAnnotationNumber) ||
        !Array.isArray(round.annotations) || !Array.isArray(round.feedback) || !object(round.noteOverrides) ||
        (round.noteRecords !== undefined && (!Array.isArray(round.noteRecords) ||
          round.noteRecords.some((record) => !object(record) || !text(record.id) || !text(record.raw) ||
            !text(record.before) || !text(record.after) || !text(record.reason) || !text(record.location))))) {
      throw new Error('备份包含无效的校对轮次。');
    }
    const validBase = round.baseRoundId ? project.rounds.find((r) => r.id === round.baseRoundId && ids.has(r.id))?.revised : project.original;
    if (validBase?.hash !== round.base.hash) throw new Error('备份含有无效的对比基准。');
    const noteIds = new Set();
    for (const annotation of round.annotations) {
      if (!object(annotation) || !text(annotation.id) || noteIds.has(annotation.id) || !text(annotation.comment) ||
          !text(annotation.quote) || !text(annotation.paragraph) || !text(annotation.anchor) ||
          !['left', 'right'].includes(annotation.side) || !['pending', 'confirmed'].includes(annotation.status) ||
          !Number.isInteger(annotation.start) || !Number.isInteger(annotation.end) ||
          annotation.start < 0 || annotation.end <= annotation.start) throw new Error('备份包含无效的人工批注。');
      noteIds.add(annotation.id);
      if (annotation.parts !== undefined && (!Array.isArray(annotation.parts) || annotation.parts.length < 2 ||
          annotation.parts.some((part) => !object(part) || !text(part.anchor) || !text(part.paragraph) ||
            !text(part.quote) || !Number.isInteger(part.start) || !Number.isInteger(part.end) ||
            part.start < 0 || part.end <= part.start || part.end > part.paragraph.length ||
            part.paragraph.slice(part.start, part.end) !== part.quote))) throw new Error('备份包含无效的跨段批注。');
      if (annotation.changeIds !== undefined && (!Array.isArray(annotation.changeIds) ||
          !annotation.changeIds.every(text))) throw new Error('备份包含无效的批注修改编号。');
    }
    if (round.feedback.some((item) => !object(item) || !text(item.markdown) || !text(item.createdAt))) {
      throw new Error('备份包含无效的反馈记录。');
    }
    ids.add(round.id);
  }
}

export async function restoreProject(file) {
  if (!file.size || file.size > backupLimit + 1024 * 1024) throw new Error('备份为空或超过 384 MB。');
  let size = 0;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let invalid = false;
  const files = await new Promise((resolve, reject) => unzip(bytes, {
    filter(entry) {
      const manifest = entry.name === 'project.json';
      if (!manifest && !/^files\/[a-f0-9]{64}$/.test(entry.name)) return false;
      size += entry.originalSize;
      if (size > backupLimit || entry.originalSize > (manifest ? 48 * 1024 * 1024 : fileLimit)) {
        invalid = true;
        return false;
      }
      return true;
    },
  }, (error, result) => error ? reject(error) : resolve(result)));
  if (invalid || !files['project.json']) throw new Error('备份超过容量限制或缺少项目清单。');
  const payload = JSON.parse(strFromU8(files['project.json']));
  if (payload?.format !== 'docx-review-project' || payload.version !== 1) throw new Error('不支持此备份格式。');
  validate(payload.project);
  const project = { ...payload.project, id: crypto.randomUUID(), version: 1,
    updatedAt: new Date().toISOString(), name: payload.project.name + '（恢复）' };
  const staged = [];
  for (const ref of refsOf(project)) {
    const content = files['files/' + ref.hash];
    if (!content || await fingerprint(content) !== ref.hash) throw new Error('备份文件缺失或校验失败：' + ref.name);
    staged.push({ ref, file: new File([content], ref.name, { type: ref.type }) });
  }
  return { project, staged };
}
