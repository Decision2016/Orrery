import { useState, type FormEvent } from 'react';
import {
  AlertTriangle, Check, CheckCircle2, Circle, Copy, Folder, ListTodo, LoaderCircle, Plus, Trash2, X,
} from 'lucide-react';
import type { TodoItem, TodoPriority, TodoStatus } from '@orrery/shared';
import { clearCompletedTodos, createTodo, deleteTodo, updateTodo } from '../../lib/api';
import { formatClock } from '../../lib/format';
import { EmptyState } from '../Telemetry';

type TodoTab = 'open' | 'all' | 'done';

const states: Record<TodoStatus, readonly [string, string, typeof Circle]> = {
  in_progress: ['进行中', 'tone-cyan', LoaderCircle],
  blocked: ['受阻', 'tone-rose', AlertTriangle],
  pending: ['待处理', 'tone-blue', Circle],
  done: ['已完成', 'tone-green', CheckCircle2],
};

const priorities: Record<TodoPriority, readonly [string, string]> = {
  critical: ['紧急', 'tone-rose'],
  high: ['高优', 'tone-amber'],
  normal: ['待办', ''],
  low: ['低优', 'tone-muted'],
};

const NEXT_STATUS: Record<TodoStatus, TodoStatus> = {
  pending: 'in_progress',
  in_progress: 'done',
  blocked: 'in_progress',
  done: 'pending',
};

const AGENT_GUIDE = [
  '你可以将当前任务的待办清单实时同步到 Orrery 副屏监视台：',
  '1. HTTP 接口（实时推送）：',
  '   - 新增或按 id 幂等更新：POST http://127.0.0.1:4318/api/todos',
  '     JSON: {"id":"step-1","title":"任务标题","status":"in_progress","priority":"high","agent":"Codex","project":"项目名","note":"步骤备注"}',
  '   - 更新状态：PATCH http://127.0.0.1:4318/api/todos/step-1  JSON: {"status":"done"}',
  '   - 批量全量同步：PUT http://127.0.0.1:4318/api/todos  JSON: {"items":[...]}',
  '   （status: pending | in_progress | blocked | done；priority: low | normal | high | critical）',
  '2. 文件直写（无需网络）：直接读写 ~/.orrery/todos.json（格式 {"items":[...]}），Orrery 每秒自动热加载。',
].join('\n');

function agentTone(agent?: string): string {
  const lower = (agent ?? '').toLowerCase();
  if (!lower) return 'tone-cyan';
  if (lower.includes('t3') && lower.includes('codex')) return 'tone-violet';
  if (lower.includes('t3')) return 'tone-blue';
  if (lower.includes('codex')) return 'tone-green';
  if (lower.includes('antigravity') || lower.includes('gemini')) return 'tone-violet';
  if (lower.includes('claude')) return 'tone-amber';
  return 'tone-cyan';
}

export function TodoListWidget({ todos, onNotice }: { todos: TodoItem[]; onNotice: (msg: string) => void }) {
  const [tab, setTab] = useState<TodoTab>('open');
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [priority, setPriority] = useState<TodoPriority>('normal');
  const [busyId, setBusyId] = useState('');
  const [copied, setCopied] = useState(false);

  const doneCount = todos.filter(item => item.status === 'done').length;
  const openCount = todos.length - doneCount;
  const visible = todos.filter(item => tab === 'all' ? true : tab === 'done' ? item.status === 'done' : item.status !== 'done');

  async function runAction(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    try {
      await fn();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '待办操作失败');
    } finally {
      setBusyId('');
    }
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    await runAction('__create__', async () => {
      await createTodo({
        title: trimmed,
        priority,
        status: 'pending',
        agent: 'Local',
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setTitle('');
      setNote('');
      setPriority('normal');
      setAdding(false);
      if (tab === 'done') setTab('open');
    });
  }

  async function handleCopyGuide() {
    try {
      await navigator.clipboard.writeText(AGENT_GUIDE);
      setCopied(true);
      onNotice('已复制 Agent 写入说明，可直接粘贴给任意 Agent');
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      onNotice('复制失败，Agent 可直接写入 http://127.0.0.1:4318/api/todos 或 ~/.orrery/todos.json');
    }
  }

  return (
    <div className="widget-column">
      <div className="widget-toolbar">
        <div className="segments" role="group" aria-label="筛选待办">
          <button type="button" aria-pressed={tab === 'open'} onClick={() => setTab('open')}>
            待办 <span>{openCount}</span>
          </button>
          <button type="button" aria-pressed={tab === 'all'} onClick={() => setTab('all')}>
            全部 <span>{todos.length}</span>
          </button>
          <button type="button" aria-pressed={tab === 'done'} onClick={() => setTab('done')}>
            已完成 <span>{doneCount}</span>
          </button>
        </div>
        <div className="inline-group">
          <button type="button" className={`action-button ${adding ? 'primary-button' : ''}`} onClick={() => setAdding(open => !open)} title="新建待办事项">
            <Plus size={13} />新建
          </button>
          <button type="button" className="action-button" onClick={handleCopyGuide} title="复制给 AI Agent 的 API / JSON 写入说明">
            {copied ? <Check size={13} /> : <Copy size={13} />}Agent 接入
          </button>
          {doneCount > 0 && (
            <button
              type="button"
              className="action-button"
              disabled={busyId === '__clear__'}
              onClick={() => runAction('__clear__', () => clearCompletedTodos())}
              title="清理全部已完成事项"
            >
              <Trash2 size={13} />清理
            </button>
          )}
        </div>
      </div>

      {adding && (
        <form className="todo-compose" onSubmit={handleCreate}>
          <div className="todo-compose-main">
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="输入待办标题，回车添加…"
              maxLength={500}
              autoFocus
            />
            <select value={priority} onChange={e => setPriority(e.target.value as TodoPriority)} aria-label="优先级">
              <option value="normal">普通</option>
              <option value="high">高优</option>
              <option value="critical">紧急</option>
              <option value="low">低优</option>
            </select>
            <button type="submit" className="primary-button" disabled={!title.trim() || busyId === '__create__'}>添加</button>
          </div>
          <input
            type="text"
            className="todo-compose-note"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="备注或步骤说明（可选）"
            maxLength={500}
          />
        </form>
      )}

      {!visible.length ? (
        <EmptyState icon={todos.length && tab === 'open' ? CheckCircle2 : ListTodo}>
          {!todos.length
            ? '暂无待办事项 · 点击右上角「Agent 接入」可复制写入指令交给任意 Agent'
            : tab === 'open'
              ? '当前待办已全部完成'
              : '暂无已完成事项'}
        </EmptyState>
      ) : (
        <div className="widget-scroll schedule-list">
          {visible.map(item => {
            const [stateLabel, tone, StatusIcon] = states[item.status];
            const [prioLabel, prioTone] = priorities[item.priority];
            const busy = busyId === item.id;
            return (
              <article className={`schedule-row todo-row ${item.status === 'done' ? 'is-done' : ''}`} key={item.id}>
                <div className="between">
                  <span className="schedule-kind">
                    <button
                      type="button"
                      className={`todo-check ${tone}`}
                      disabled={busy}
                      onClick={() => runAction(item.id, () => updateTodo(item.id, { status: item.status === 'done' ? 'pending' : 'done' }))}
                      title={item.status === 'done' ? '重新标为待处理' : '标为已完成'}
                      aria-label={item.status === 'done' ? '重新标为待处理' : '标为已完成'}
                    >
                      <StatusIcon size={14} />
                    </button>
                    <span className={prioTone}>{prioLabel}</span>
                    <small className={agentTone(item.agent)}>{item.agent || 'Local'}</small>
                    {item.project && <small className="tone-muted">· {item.project}</small>}
                  </span>
                  <span className="inline-group">
                    <button
                      type="button"
                      className={`state-pill todo-pill-btn ${tone}`}
                      disabled={busy}
                      onClick={() => runAction(item.id, () => updateTodo(item.id, { status: NEXT_STATUS[item.status] }))}
                      title="点击切换状态（待处理 → 进行中 → 已完成）"
                    >
                      <i className={`dot ${item.status === 'in_progress' ? 'pulse' : ''}`} />
                      {stateLabel}
                    </button>
                    <button
                      type="button"
                      className="todo-remove"
                      disabled={busy}
                      onClick={() => runAction(item.id, () => deleteTodo(item.id))}
                      title="删除待办"
                      aria-label="删除待办"
                    >
                      <X size={13} />
                    </button>
                  </span>
                </div>
                <h3>{item.title}</h3>
                {item.note && <p className="schedule-rule">{item.note}</p>}
                <div className="schedule-times">
                  <span>更新 <time title={item.updatedAt}>{formatClock(item.updatedAt)}</time></span>
                  {item.completedAt && <span>完成 <time title={item.completedAt}>{formatClock(item.completedAt)}</time></span>}
                  {item.cwd && <span className="mono todo-cwd" title={item.cwd}><Folder size={11} />{item.cwd}</span>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
