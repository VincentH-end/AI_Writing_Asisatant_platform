import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export const hash = s => createHash('sha256').update(s || '').digest('hex');
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const wordCount = s => [...(s || '').replace(/\s/g, '')].length;
export const collections = ['chapters', 'entities', 'events', 'materials', 'techniques', 'branches', 'runs'];
export const defaultSettings = {
  base_url: 'https://api.deepseek.com', model: '', models: {}, creativity: 'balanced',
  auto_update: false, context_budget: 16000, max_output_tokens: 3000,
  send_temperature: true,
};

export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true });
    this.dir = dir;
    const keyPath = join(dir, 'master.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(keyPath);
    this.db = new DatabaseSync(join(dir, 'stories.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_project_kind ON records(project_id,kind);
      CREATE TABLE IF NOT EXISTS revisions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chapter_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      PRAGMA user_version=1;`);
    if (!this.projects().length) this.seed();
    // A request interrupted by process shutdown cannot remain deceptively running.
    for (const p of this.projects()) for (const r of this.list(p.id, 'runs').filter(x => x.status === 'running')) {
      this.put(p.id, 'runs', { ...r, status: 'failed', error: '服务重启，中断的生成未自动重试；请手动重新生成。' });
    }
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  meta(key, value) {
    if (value !== undefined) this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  }
  active() { return this.meta('active_project'); }
  projects() { return this.db.prepare('SELECT data FROM projects').all().map(r => JSON.parse(r.data)); }
  project(pid) { const r = this.db.prepare('SELECT data FROM projects WHERE id=?').get(pid); return r ? JSON.parse(r.data) : null; }
  putProject(p) {
    const saved = { ...p, updated_at: now() };
    this.db.prepare('INSERT INTO projects VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(saved.id, JSON.stringify(saved));
    return saved;
  }
  list(pid, kind) {
    return this.db.prepare('SELECT data FROM records WHERE project_id=? AND kind=?').all(pid, kind).map(r => JSON.parse(r.data));
  }
  get(pid, kind, rid) {
    const r = this.db.prepare('SELECT data FROM records WHERE project_id=? AND kind=? AND id=?').get(pid, kind, rid);
    return r ? JSON.parse(r.data) : null;
  }
  put(pid, kind, data) {
    const saved = { ...data, id: data.id || id(), project_id: pid, updated_at: now() };
    const owner = this.db.prepare('SELECT project_id,kind FROM records WHERE id=?').get(saved.id);
    if (owner && (owner.project_id !== pid || owner.kind !== kind)) throw new Error('记录 ID 冲突');
    this.db.prepare('INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(saved.id, pid, kind, JSON.stringify(saved));
    return saved;
  }
  revision(pid, chapter) {
    this.db.prepare('INSERT INTO revisions VALUES (?,?,?,?,?)').run(id(), pid, chapter.id, JSON.stringify(chapter), now());
  }
  revisions(pid, cid) {
    return this.db.prepare('SELECT id,data,created_at FROM revisions WHERE project_id=? AND chapter_id=? ORDER BY created_at DESC LIMIT 50').all(pid, cid).map(r => ({ id: r.id, chapter: JSON.parse(r.data), created_at: r.created_at }));
  }
  encrypt(s) {
    if (!s) return '';
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    return Buffer.concat([iv, cipher.update(s, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  }
  decrypt(s) {
    if (!s) return '';
    const b = Buffer.from(s, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    decipher.setAuthTag(b.subarray(-16));
    return Buffer.concat([decipher.update(b.subarray(12, -16)), decipher.final()]).toString('utf8');
  }
  settings(secret = false) {
    const saved = this.meta('settings') || {};
    const result = { ...defaultSettings, ...saved };
    const envUrl = process.env.AI_BASE_URL || defaultSettings.base_url;
    if (!saved.base_url && process.env.AI_BASE_URL) result.base_url = process.env.AI_BASE_URL;
    if (!result.model && process.env.AI_MODEL) result.model = process.env.AI_MODEL;
    const key = this.decrypt(saved.encrypted_key || '') || (result.base_url === envUrl ? process.env.AI_API_KEY || '' : '');
    delete result.encrypted_key;
    if (secret) result.api_key = key;
    result.has_api_key = !!key;
    return result;
  }
  saveSettings(patch) {
    const existing = this.meta('settings') || {};
    const previous = this.settings(true);
    const { api_key, has_api_key, encrypted_key, ...safe } = patch;
    const saved = { ...existing, ...safe };
    if (api_key !== undefined) saved.encrypted_key = this.encrypt(api_key);
    else if (safe.base_url && safe.base_url !== previous.base_url) saved.encrypted_key = '';
    this.meta('settings', saved);
    return this.settings();
  }
  snapshot(pid = this.active()) {
    const project = this.project(pid);
    const result = { project, settings: this.settings() };
    for (const c of collections) result[c] = this.list(pid, c);
    result.chapters.sort((a,b) => a.position - b.position);
    result.chapters = result.chapters.map(c => ({ ...c, word_count: wordCount(c.content) }));
    result.runs.sort((a,b) => b.created_at.localeCompare(a.created_at));
    result.stats = {
      words: result.chapters.reduce((s,c) => s + c.word_count, 0),
      chapters: result.chapters.length, volumes: new Set(result.chapters.map(c => c.volume)).size,
      characters: result.entities.filter(e => ['character','人物'].includes(e.type)).length,
      entities: result.entities.length, factions: result.entities.filter(e => ['faction','势力'].includes(e.type)).length,
      events: result.events.length, materials: result.materials.length,
      ai_calls: result.runs.length,
      usage_tokens: result.runs.reduce((s,r) => s + (r.usage?.total_tokens || 0), 0),
    };
    return result;
  }
  newProject(data) {
    const p = this.putProject({ id: id(), title: data.title, genre: data.genre || '', synopsis: data.synopsis || '', outline: data.outline || '', mode: data.mode || 'assisted', created_at: now() });
    this.put(p.id, 'chapters', { id: id(), title: '第一章', volume: '第一卷', content: '', outline: '', summary: '', position: 1, status: 'draft', created_at: now() });
    this.meta('active_project', p.id);
    return p;
  }
  seed() {
    const p = this.newProject({ title: '雾海来信', genre: '悬疑 / 奇幻', synopsis: '地图修复师林见秋重返雾港，收到失踪父亲的来信，追寻灯塔与潮汐的秘密。' });
    const c = this.list(p.id,'chapters')[0];
    this.put(p.id,'chapters',{ ...c, title:'来自雾海的信', outline:'来信唤醒旧事。林见秋从潮汐暗号中找到前往北岸灯塔的线索。', content:'雾是在黄昏时分漫上来的。\n\n林见秋站在码头尽头，把那封信又读了一遍。纸页被海风吹得微微发脆，字迹却清晰得像刚刚落笔。她认得父亲的字，尤其是那个总要多绕半圈的“秋”字。\n\n可父亲已经失踪了整整十年。\n\n“别等潮水退去。”信上只有这六个字。\n\n远处，北岸的旧灯塔在雾中露出模糊的轮廓。她把信折好，放进贴身的口袋，指尖碰到了一枚冰凉的铜钥匙。' });
    const a=this.put(p.id,'entities',{type:'character',name:'林见秋',description:'地图修复师，十年前离乡，如今重返雾港。',state:'收到来信，持有铜钥匙；从疑虑转向决意。',chapter_id:c.id,history:[],relations:[]});
    const b=this.put(p.id,'entities',{type:'character',name:'沈舟',description:'钟表铺主人，父亲失踪前的见证人。',state:'交出钥匙，有所隐瞒。',chapter_id:c.id,history:[],relations:[{target_id:a.id,label:'旧友，谨慎信任',chapter_id:c.id,status:'active'}]});
    this.put(p.id,'entities',{type:'item',name:'铜钥匙',description:'波浪形齿纹，据说能打开旧灯塔的一扇门。',state:'由沈舟交给林见秋。',chapter_id:c.id,history:[],relations:[]});
    this.put(p.id,'entities',{type:'location',name:'北岸旧灯塔',description:'位于礁石小路尽头，大退潮时可以步行到达。',state:'已停用十年。',chapter_id:c.id,history:[],relations:[]});
    this.put(p.id,'events',{title:'十年前的失踪',description:'林父在风暴夜失踪，沈舟可能知情。',status:'investigating',theme:'记忆与真相',ending:'揭开主动离开的原因',chapter_id:c.id});
    this.put(p.id,'materials',{title:'雾中的声音',content:'低频船笛、潮水碰撞石阶、远处断续的钟声。用听觉建立能见度受限的空间。',tags:['海洋','氛围']});
    this.put(p.id,'techniques',{name:'铜钥匙的伏笔',scope:'global',description:'在灯塔入口回收钥匙线索，不提前揭露门后真相。',planted_chapter:c.id,payoff_chapter:'',status:'open'});
  }
}
