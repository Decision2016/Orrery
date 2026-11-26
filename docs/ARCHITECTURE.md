# Orrery Architecture & Implementation Spec

Orrery is a local-first AI Agent observatory and 3840×1100 GridStack.js control deck for **T3 Code**, **Codex** (Desktop App + CLI), and extensible future local agents (Claude Code, OpenCode, etc.).

## Monorepo Layout
- `packages/shared` (`@orrery/shared`): Canonical TypeScript types (`OrrerySnapshot`, `TaskItem`, `AgentRuntime`, `SubagentNode`, `AttentionAlert`, `ScheduledItem`, `EventEntry`, `LayoutPreset`, etc.) and built-in 24×10 GridStack layout presets.
- `packages/server` (`@orrery/server`): Node 24 TypeScript local service (`127.0.0.1:4318`), zero native addon dependencies (uses built-in `node:sqlite` in read-only mode), serving REST + SSE + static built web assets.
- `packages/web` (`@orrery/web`): React 19 + Tailwind CSS v4 + GridStack.js 24×10 viewport-locked cockpit designed for 3840×1100 ultrawide monitors (with DPI-adaptive dynamic `cellHeight`).
- `scripts/`: PowerShell launchers for browser fullscreen/kiosk on 3840×1100 monitor and one-click service start.
- `src-tauri/`: Phase 3 Tauri v2 lightweight Windows desktop wrapper with monitor detection, borderless 3840×1100 snap, system tray, managed local server lifecycle, and native notifications.

## Verified Local Data Sources (Windows)

### 1. T3 Code (`~/.t3/userdata` and `~/.t3/caches`)
- `statev2.sqlite` (WAL, read-only):
  - `projection_projects` (`project_id`, `title`, `workspace_root`, `deleted_at`)
  - `orchestration_v2_projection_threads` (`thread_id`, `project_id`, `title`, `default_provider`, `runtime_mode`, `interaction_mode`, `active_provider_thread_id`, `created_at`, `updated_at`, `archived_at`, `deleted_at`, `payload_json`, `provider_instance_id`)
  - `orchestration_v2_projection_runs` (`run_id`, `thread_id`, `ordinal`, `provider`, `provider_thread_id`, `status`, `requested_at`, `completed_at`, `payload_json`, `provider_instance_id`)
  - `orchestration_v2_projection_provider_threads` (`provider_thread_id`, `thread_id`, `provider`, `status`, `updated_at`, `payload_json` -> contains `nativeThreadRef.nativeId` for Codex UUID join and `contextUsage: { usedTokens, maxTokens }`)
  - `orchestration_v2_projection_nodes` (`node_id`, `thread_id`, `run_id`, `parent_node_id`, `kind`, `status`, `started_at`, `completed_at`, `payload_json`)
  - `orchestration_v2_projection_turn_items` (`turn_item_id`, `thread_id`, `run_id`, `type`, `status`, `updated_at`, `payload_json`, `inline_work_output`)
  - `orchestration_v2_projection_subagents` (`subagent_id`, `thread_id`, `run_id`, `parent_node_id`, `provider`, `child_thread_id`, `origin`, `status`, `started_at`, `completed_at`, `updated_at`, `payload_json`)
  - `orchestration_v2_projection_runtime_requests` (`runtime_request_id`, `thread_id`, `kind`, `status`, `created_at`, `resolved_at`, `payload_json` -> status `'pending'` = needs attention)
  - `orchestration_v2_events` (`sequence`, `event_id`, `thread_id`, `run_id`, `provider`, `event_type`, `occurred_at`, `payload_json`)
  - `scheduled_tasks` (`task_id`, `title`, `enabled`, `schedule_json`, `next_run_at`, `last_run_at`, `last_run_status`, `last_run_error`, `run_count`, `model_selection_json`)
- `server-runtime.json`: `{ version, pid, host, port, origin, startedAt, serverVersion }`
- `~/.t3/caches/*.json`: `{ displayName, enabled, installed, version, status, checkedAt, usageLimits: { checkedAt, windows: [{ id, kind, label, usedPercent, resetsAt }], unavailable } }`

### 2. Codex (`~/.codex`)
- `state_5.sqlite` (WAL, read-only):
  - `threads`: `id`, `rollout_path`, `created_at_ms`, `updated_at_ms`, `source`, `model_provider`, `cwd` (strip `\\?\` prefix!), `title`, `sandbox_policy`, `approval_mode`, `tokens_used`, `archived`, `git_branch`, `cli_version`, `model`, `reasoning_effort`, `originator`, `thread_source`, `agent_nickname`, `agent_role`, `attached_thread_parent_id`
  - `thread_spawn_edges`: `parent_thread_id`, `child_thread_id`, `status`
  - `projects` & `project_roots`
- `sqlite/codex.db`:
  - `active_chat_turns`: `thread_id`, `launch_id`, `observed_at_ms`
  - `automations`: `id`, `name`, `status`, `next_run_at`, `last_run_at`, `rrule`, `model`, `cwds`
  - `automation_runs`: `thread_id`, `automation_id`, `status`, `thread_title`, `created_at`, `updated_at`
  - `inbox_items`: `id`, `title`, `description`, `thread_id`, `read_at`, `created_at`
- `queue_1.sqlite`:
  - `queued_items`: `id`, `thread_id`, `payload_json`, `queue_order`, `created_at_ms`, `updated_at_ms`
- `logs_2.sqlite`:
  - `logs`: `id`, `ts`, `level`, `target`, `feedback_log_body`, `thread_id` (filter `WARN`/`ERROR` with cursor on `id`)
- `sessions/YYYY/MM/DD/rollout-*.jsonl`:
  - Incrementally tail only recently updated files (by byte offset) to extract `event_msg/token_count`, `response_item/custom_tool_call`, `response_item/reasoning`, `event_msg/task_started`, `turn_context`.

### 3. Cross-Source Deduplication (`T3 → Codex`)
- Match T3 `provider_threads.payload_json.nativeThreadRef.nativeId === codex.threads.id` (or fallback via Codex `originator === 'T3 Code'` + matching `cwd` & close timestamp).
- Merge matched pair into a single `TaskItem` with `source: 't3-codex'`, `sourceLabel: 'T3 → Codex'`, combining T3 approvals/project/subagents with Codex JSONL token/tool granularity.

### 4. Server REST & SSE API Contract (`127.0.0.1:4318`)
- `GET /api/health` -> `{ ok: true, version, uptimeSec, startedAt, collectors }`
- `GET /api/snapshot` -> `OrrerySnapshot`
- `GET /api/stream` -> `text/event-stream` (`event: snapshot`, `event: heartbeat`)
- `GET /api/tasks/:id` -> `TaskItem` (404 if not found)
- `GET /api/layouts` -> `LayoutsPayload`
- `PUT /api/layouts` -> accepts `LayoutsPayload`, persists to `~/.orrery/layouts.json`, returns saved `LayoutsPayload`
- `POST /api/actions/open-folder` -> `{ path: string }` opens directory in Windows Explorer (validates path exists & is directory)
- `POST /api/actions/open-url` -> `{ url: string }` opens safe localhost/http(s) URL (e.g. T3 Code thread)
