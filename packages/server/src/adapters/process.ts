import { execFile } from 'node:child_process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import type { ProcessMetric } from '@orrery/shared';
import type { OrreryConfig } from '../config.js';
import type { CollectorAdapter } from './types.js';
import { collectorOutput, numberValue, parseJson, record, stringValue, timestamp } from './sqlite.js';

const execute = promisify(execFile);
const processQuery = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$filter = "Name LIKE 'T3 Code%.exe' OR Name='t3code.exe' OR Name='t3-resource-monitor.exe' OR Name='codex.exe' OR Name='ChatGPT.exe' OR Name='codex-code-mode-host.exe' OR Name='codex-computer-use-swift.exe' OR Name='claude.exe' OR Name='opencode.exe' OR Name='node.exe'"
$rows = @(Get-CimInstance -ClassName Win32_Process -Filter $filter -Property Name,ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,CommandLine,CreationDate | ForEach-Object {
  if ($_.Name -ne 'node.exe' -or $_.CommandLine -match '@openai[\\/]codex|@anthropic-ai[\\/]claude-code|[\\/]opencode-ai[\\/]') {
    [pscustomobject]@{
      name = $_.Name
      pid = $_.ProcessId
      ppid = $_.ParentProcessId
      memory = [double]$_.WorkingSetSize
      ticks = [double]$_.KernelModeTime + [double]$_.UserModeTime
      command = $_.CommandLine
      started = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') }
    }
  }
})
ConvertTo-Json -InputObject $rows -Depth 2 -Compress`;

export class ProcessAdapter implements CollectorAdapter {
  readonly id = 'process';
  readonly name = 'Host processes';
  readonly intervalMs: number;
  private metrics: ProcessMetric[] = [];
  private processSample?: Promise<ProcessMetric[]>;
  private nextSampleAt = -Infinity;
  private sampledAt = -Infinity;
  private ticks = new Map<number, { ticks: number; started?: string }>();
  private previousCpu?: { idle: number; total: number };

  constructor(config: OrreryConfig) {
    this.intervalMs = config.processPollIntervalMs;
  }

  sampleProcesses(): Promise<ProcessMetric[]> {
    if (this.processSample) return this.processSample;
    if (process.platform !== 'win32' || performance.now() < this.nextSampleAt) return Promise.resolve(this.metrics);
    this.nextSampleAt = performance.now() + this.intervalMs;
    this.processSample = execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', processQuery], {
      windowsHide: true, timeout: 6_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
    }).then(({ stdout }) => {
      const raw = parseJson(stdout);
      if (!Array.isArray(raw)) return this.metrics;
      const now = performance.now();
      const elapsed = now - this.sampledAt;
      const cores = Math.max(1, os.cpus().length);
      const ticks = new Map<number, { ticks: number; started?: string }>();
      this.metrics = raw.flatMap(value => {
        const row = record(value);
        const pid = numberValue(row.pid);
        const name = stringValue(row.name);
        if (!pid || !name) return [];
        const image = name.replace(/\.exe$/i, '').toLowerCase();
        const command = stringValue(row.command);
        const node = image === 'node';
        const agentId = /^t3/.test(image) ? 't3'
          : image === 'claude' || (node && /@anthropic-ai[\\/]claude-code/i.test(command ?? '')) ? 'claude-code'
          : image === 'opencode' || (node && /[\\/]opencode-ai[\\/]/i.test(command ?? '')) ? 'opencode' : 'codex';
        const role = image === 't3-resource-monitor' ? 'resource monitor'
          : image === 'codex-code-mode-host' ? 'code mode host' : image === 'codex-computer-use-swift' ? 'computer use'
          : command?.match(/--type[= ]"?([\w-]+)/)?.[1] ?? (/\bapp-server\b/.test(command ?? '') ? 'app server'
            : image === 'chatgpt' || /^t3/.test(image) ? 'desktop' : 'CLI');
        const started = timestamp(row.started);
        const cpuTicks = numberValue(row.ticks) ?? 0;
        const prev = this.ticks.get(pid);
        // CIM uses 100 ns ticks. Report process CPU as a share of the whole host.
        const percent = prev && started === prev.started && elapsed > 0 ? (cpuTicks - prev.ticks) / (100 * elapsed * cores) : 0;
        ticks.set(pid, { ticks: cpuTicks, started });
        return [{ pid, ppid: numberValue(row.ppid) ?? 0, name, role, agentId, cpuPercent: Math.min(100, Math.max(0, percent)),
          memoryMb: (numberValue(row.memory) ?? 0) / 1024 ** 2, commandLine: command, startedAt: started }];
      });
      this.ticks = ticks;
      this.sampledAt = now;
      return this.metrics;
    }, () => this.metrics).finally(() => { this.processSample = undefined; });
    return this.processSample;
  }

  async collect() {
    const processes = await this.sampleProcesses();
    const cpus = os.cpus().reduce((sum, cpu) => ({
      idle: sum.idle + cpu.times.idle,
      total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
    }), { idle: 0, total: 0 });
    const prev = this.previousCpu;
    const delta = prev ? cpus.total - prev.total : 0;
    const cpuPercent = prev && delta > 0 ? 100 * (1 - (cpus.idle - prev.idle) / delta) : 0;
    this.previousCpu = cpus;
    const total = os.totalmem(), used = total - os.freemem();
    const at = new Date().toISOString();
    const result = collectorOutput(this.id, at);
    result.processes = processes;
    result.host = {
      cpuPercent: Math.max(0, Math.min(100, cpuPercent)), memoryUsedGb: used / 1024 ** 3, memoryTotalGb: total / 1024 ** 3,
      memoryPercent: total > 0 ? 100 * used / total : 0, agentProcessCount: processes.length, uptimeSec: os.uptime(), collectedAt: at,
    };
    return result;
  }
}
