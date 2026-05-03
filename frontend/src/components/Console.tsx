/**
 * Console — the actual builder chat surface.
 *
 * Streams from POST /api/console/stream as SSE. Renders text deltas live,
 * shows tool calls inline as they happen. Per-project history persists to
 * localStorage. Native textarea so OS dictation (iPad mic, Mac fn-fn,
 * Win+H) Just Works — no custom STT layer.
 *
 * When the project is linked to a repo, every completed turn also writes a
 * session summary to .holdenmercer/sessions/<timestamp>.md so future Claude
 * sessions can read what happened. The repo IS the memory.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useChat, newChatId, type ChatMessage, type ToolCall } from '../stores/chat'
import { useProjects } from '../stores/projects'
import { useSettings } from '../stores/settings'
import { useAuth } from '../stores/auth'
import { writeFile } from '../lib/repo'

interface Props {
  projectId: string
}

const ALL_TOOLS = [
  'web_fetch',
  'read_github_file',
  'list_github_repos',
  'list_github_dir',
  'write_github_file',
  'delete_github_file',
  'create_github_branch',
  'setup_gate_workflow',
  'run_gate',
  'check_gate',
  'read_gate_logs',
] as const

export function Console({ projectId }: Props) {
  const project       = useProjects((s) => s.projects.find((p) => p.id === projectId))
  const messages      = useChat((s) => s.threads[projectId] ?? [])
  const appendMessage = useChat((s) => s.appendMessage)
  const patchMessage  = useChat((s) => s.patchMessage)
  const appendTool    = useChat((s) => s.appendToolCall)
  const patchTool     = useChat((s) => s.patchToolCall)
  const clearThread   = useChat((s) => s.clearThread)
  const consumePending = useChat((s) => s.consumePendingInput)

  const settings = useSettings()
  const token    = useAuth((s) => s.token)

  const [input,    setInput]    = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const abortRef  = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  // Pick up any pending input the Gate tab pushed into the composer.
  useEffect(() => {
    const pending = consumePending(projectId)
    if (pending) setInput(pending)
    // Only on project change, not on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const ready = useMemo(() => Boolean(settings.anthropicKey && project), [settings.anthropicKey, project])

  if (!project) return null

  const send = async () => {
    if (!input.trim() || streaming || !ready || !token) return
    setError(null)

    const userMessage: ChatMessage = {
      id:        newChatId(),
      role:      'user',
      text:      input.trim(),
      toolCalls: [],
      createdAt: Date.now(),
    }
    appendMessage(projectId, userMessage)
    setInput('')

    const assistantId = newChatId()
    const assistantMessage: ChatMessage = {
      id:        assistantId,
      role:      'assistant',
      text:      '',
      toolCalls: [],
      createdAt: Date.now(),
      streaming: true,
    }
    appendMessage(projectId, assistantMessage)
    setStreaming(true)

    const systemPrompt = buildSystemPrompt({
      name:        project.name,
      description: project.description,
      repo:        project.repo,
      branch:      project.branch,
      autonomy:    settings.autonomy,
    })
    const apiMessages = [...messages, userMessage].map(toApiMessage)

    const ac = new AbortController()
    abortRef.current = ac
    let accumulatedText = ''
    const collectedToolCalls: ToolCall[] = []

    try {
      const res = await fetch('/api/console/stream', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          messages:       apiMessages,
          system:         systemPrompt,
          anthropic_key:  settings.anthropicKey,
          github_token:   settings.githubToken,
          model:          settings.defaultModel,
          autonomy:       settings.autonomy,
          tools_enabled:  ALL_TOOLS,
        }),
        signal: ac.signal,
      })

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => res.statusText)
        throw new Error(`HTTP ${res.status}: ${detail}`)
      }

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let nlIndex
        while ((nlIndex = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, nlIndex)
          buffer = buffer.slice(nlIndex + 2)
          const event = parseSseEvent(raw)
          if (!event) continue

          if (event.event === 'text_delta') {
            accumulatedText += event.data.delta ?? ''
            patchMessage(projectId, assistantId, { text: accumulatedText })
          } else if (event.event === 'tool_use_start') {
            const tc: ToolCall = {
              id:     event.data.id,
              tool:   event.data.tool,
              input:  event.data.input ?? {},
              status: 'running',
            }
            appendTool(projectId, assistantId, tc)
            collectedToolCalls.push(tc)
          } else if (event.event === 'tool_use_result') {
            patchTool(projectId, assistantId, event.data.id, {
              status:  'ok',
              preview: event.data.output ?? '',
            })
            const existing = collectedToolCalls.find((c) => c.id === event.data.id)
            if (existing) {
              existing.status  = 'ok'
              existing.preview = event.data.output ?? ''
            }
          } else if (event.event === 'tool_use_error') {
            patchTool(projectId, assistantId, event.data.id, {
              status:   'error',
              errorMsg: event.data.error ?? 'unknown error',
            })
            const existing = collectedToolCalls.find((c) => c.id === event.data.id)
            if (existing) {
              existing.status   = 'error'
              existing.errorMsg = event.data.error ?? 'unknown error'
            }
          } else if (event.event === 'turn_end') {
            patchMessage(projectId, assistantId, { stopReason: event.data.stop_reason })
          } else if (event.event === 'done') {
            patchMessage(projectId, assistantId, { streaming: false })
          } else if (event.event === 'error') {
            throw new Error(event.data.message ?? 'stream error')
          }
        }
      }

      patchMessage(projectId, assistantId, { streaming: false })

      // Write a session summary to the linked repo so future Claude sessions
      // can read it. Best-effort — failure here shouldn't break the chat UX.
      if (project.repo && (accumulatedText.trim() || collectedToolCalls.length > 0)) {
        const filename = sessionFilename()
        const body     = sessionMarkdown({
          projectName:  project.name,
          userText:     userMessage.text,
          assistantText: accumulatedText,
          toolCalls:    collectedToolCalls,
          model:        settings.defaultModel,
          autonomy:     settings.autonomy,
        })
        writeFile({
          repo:           project.repo,
          path:           `.holdenmercer/sessions/${filename}`,
          content:        body,
          commit_message: `chore(memory): session ${filename}`,
        }).catch((err) => {
          console.warn('Session summary write failed', err)
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message !== 'AbortError' && !message.includes('aborted')) {
        setError(message)
        patchMessage(projectId, assistantId, {
          streaming: false,
          text: accumulatedText || `[error: ${message}]`,
        })
      } else {
        patchMessage(projectId, assistantId, { streaming: false })
      }
    } finally {
      abortRef.current = null
      setStreaming(false)
    }
  }

  const stop = () => abortRef.current?.abort()

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="hm-console">
      <div className="hm-console-thread" ref={scrollRef}>
        {messages.length === 0 ? (
          <ConsoleEmpty
            ready={ready}
            hasKey={Boolean(settings.anthropicKey)}
            hasGithub={Boolean(settings.githubToken)}
            hasRepo={Boolean(project.repo)}
            autonomy={settings.autonomy}
          />
        ) : (
          messages.map((m) => <MessageRow key={m.id} message={m} repo={project.repo} branch={project.branch} />)
        )}
      </div>

      <div className="hm-console-composer">
        {error && <div className="hm-console-error">{error}</div>}
        <textarea
          className="hm-textarea hm-console-textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder={
            ready
              ? `Ask Claude something about ${project.name}.  Cmd+Enter to send.`
              : 'Add your Anthropic API key in Settings to start.'
          }
          rows={3}
          autoCapitalize="sentences"
          autoCorrect="on"
          spellCheck
          disabled={!ready}
        />
        <div className="hm-console-actions">
          <span className="hm-console-hint">
            {streaming
              ? 'Streaming…'
              : `${settings.defaultModel} · ${settings.autonomy}${project.repo ? ` · writes to ${project.repo}` : ' · no repo linked'}`}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            {messages.length > 0 && (
              <button
                className="hm-btn-ghost"
                onClick={() => { if (confirm('Clear this conversation?')) clearThread(projectId) }}
                disabled={streaming}
              >
                Clear
              </button>
            )}
            {streaming ? (
              <button className="hm-btn-ghost" onClick={stop}>Stop</button>
            ) : (
              <button
                className="hm-btn-primary"
                onClick={send}
                disabled={!ready || !input.trim()}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function MessageRow({
  message, repo, branch,
}: { message: ChatMessage; repo: string | null; branch: string | null }) {
  return (
    <div className={`hm-msg hm-msg-${message.role}`}>
      <div className="hm-msg-role">{message.role === 'user' ? 'You' : 'Claude'}</div>
      <div className="hm-msg-body">
        {message.text ? (
          <div className="hm-msg-text">{message.text}</div>
        ) : message.streaming && message.toolCalls.length === 0 ? (
          <div className="hm-msg-text hm-msg-thinking">…thinking</div>
        ) : null}

        {message.toolCalls.map((c) => (
          <ToolCallRow key={c.id} call={c} repo={repo} branch={branch} />
        ))}

        {message.streaming && (
          <span className="hm-msg-cursor" aria-hidden>▍</span>
        )}
      </div>
    </div>
  )
}

function ToolCallRow({
  call, repo, branch,
}: { call: ToolCall; repo: string | null; branch: string | null }) {
  const summary = summariseInput(call.tool, call.input)
  const linkUrl = githubUrlForCall(call, repo, branch)
  return (
    <details className={`hm-tool hm-tool-${call.status}`} open={call.status === 'running'}>
      <summary>
        <span className="hm-tool-icon">
          {call.status === 'running' ? '◌' : call.status === 'ok' ? '●' : '✕'}
        </span>
        <span className="hm-tool-name">{call.tool}</span>
        <span className="hm-tool-summary">{summary}</span>
        {linkUrl && (
          <a
            className="hm-tool-link"
            href={linkUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            view ↗
          </a>
        )}
      </summary>
      {call.status === 'error' ? (
        <pre className="hm-tool-output hm-tool-error-output">{call.errorMsg}</pre>
      ) : call.preview ? (
        <pre className="hm-tool-output">{call.preview}</pre>
      ) : null}
    </details>
  )
}

function ConsoleEmpty({
  ready, hasKey, hasGithub, hasRepo, autonomy,
}: {
  ready: boolean
  hasKey: boolean
  hasGithub: boolean
  hasRepo: boolean
  autonomy: string
}) {
  return (
    <div className="hm-console-empty">
      <h3 className="hm-console-empty-title">Start the conversation.</h3>
      {!hasKey && (
        <p className="hm-console-empty-body">
          You haven't added your Anthropic API key yet. Click the gear (top-right)
          → <strong>Anthropic API key</strong>.
        </p>
      )}
      {hasKey && !hasGithub && (
        <p className="hm-console-empty-body">
          Tip: add a GitHub PAT in Settings so Claude can read and write your repos.
        </p>
      )}
      {hasGithub && !hasRepo && (
        <p className="hm-console-empty-body">
          This project isn't linked to a repo yet. Click <strong>+ Link a GitHub repo</strong>{' '}
          above the tabs and Claude can commit changes directly.
        </p>
      )}
      {ready && (
        <p className="hm-console-empty-body">
          {autonomy === 'manual'
            ? 'Manual mode — Claude can read and plan but not write. Switch to Smart pause or Full auto in Settings to let it commit.'
            : 'Ask Claude to build, fix, or change something. It can read any file in any of your repos and commit changes back when given a target.'}
        </p>
      )}
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildSystemPrompt({
  name, description, repo, branch, autonomy,
}: {
  name: string
  description: string
  repo: string | null
  branch: string | null
  autonomy: string
}): string {
  const parts: string[] = [
    `You are the build agent for the project "${name}". You're running inside Holden Mercer — a console for power users to build with Claude.`,
  ]

  if (description.trim()) {
    parts.push(`\nProject brief:\n${description.trim()}`)
  } else {
    parts.push(`\nThe project brief is empty. Ask the user to fill it in via the Brief tab if you need clarity.`)
  }

  if (repo) {
    parts.push(
      `\nThis project is linked to GitHub repo \`${repo}\` (default branch: \`${branch || 'main'}\`). When the user asks you to make a change, use \`write_github_file\` to commit it directly. Read existing files first with \`read_github_file\` so you don't overwrite work.`
    )
  } else {
    parts.push(
      `\nThis project is NOT linked to a GitHub repo yet, so write tools won't have a target. If the user asks you to write code, propose it as fenced code blocks and suggest they link a repo.`
    )
  }

  if (autonomy === 'manual') {
    parts.push(`\nAutonomy: MANUAL — write tools are disabled. Plan and explain only. The user will apply changes themselves.`)
  } else if (autonomy === 'smart') {
    parts.push(`\nAutonomy: SMART PAUSE — you can write files and create branches. Pause to confirm with the user before destructive ops (deleting files, large refactors), and before architecture decisions where multiple valid approaches exist.`)
  } else {
    parts.push(`\nAutonomy: FULL AUTO — you have full write access. Make sensible default choices and keep going. The user will review the commits afterwards.`)
  }

  parts.push(
    `\nTools available:`,
    `  - web_fetch(url): fetch any public web page.`,
    `  - read_github_file(repo, path): read any file from any repo.`,
    `  - list_github_repos(search?): list the user's repos.`,
    `  - list_github_dir(repo, path): list a directory in a repo.`,
    `  - write_github_file(repo, path, content, commit_message): create or overwrite a file.`,
    `  - delete_github_file(repo, path, commit_message): delete a file.`,
    `  - create_github_branch(repo, branch, from_ref?): create a branch.`,
    `  - setup_gate_workflow(repo): install the lint/typecheck/tests workflow.`,
    `  - run_gate(repo, branch?): trigger the gate; waits up to ~45s for the result.`,
    `  - check_gate(repo, run_id): poll a specific run.`,
    `  - read_gate_logs(repo, run_id): tail the failure logs of a run.`,
    `\nAlways write the FULL file content when using write_github_file — partial edits aren't supported.`,
    `\nWhen you commit changes that touch real code, run the gate afterwards (run_gate) so the user has signal that nothing broke. If the gate hasn't been installed yet, call setup_gate_workflow first. On failure, read_gate_logs, then propose / commit a fix and run the gate again — this is the self-repair loop.`,
    `\nBe concise. Skip preamble. Plans should give numbered steps with file paths and the actual change, not abstract advice.`,
  )

  return parts.join('\n')
}

function toApiMessage(m: ChatMessage): { role: 'user' | 'assistant'; content: string } {
  return { role: m.role === 'system' ? 'user' : m.role, content: m.text }
}

function summariseInput(tool: string, input: Record<string, unknown>): string {
  if (tool === 'web_fetch')           return String(input.url ?? '')
  if (tool === 'read_github_file')    return `${input.repo ?? ''}/${input.path ?? ''}${input.ref ? `@${input.ref}` : ''}`
  if (tool === 'list_github_repos')   return input.search ? `search="${input.search}"` : 'all repos'
  if (tool === 'list_github_dir')     return `${input.repo ?? ''}/${input.path ?? '(root)'}`
  if (tool === 'write_github_file')   return `${input.repo ?? ''}/${input.path ?? ''}  ←  ${input.commit_message ?? ''}`
  if (tool === 'delete_github_file')  return `${input.repo ?? ''}/${input.path ?? ''}  (delete)`
  if (tool === 'create_github_branch') return `${input.repo ?? ''}  branch=${input.branch ?? ''} from=${input.from_ref ?? 'default'}`
  if (tool === 'setup_gate_workflow') return `install gate workflow in ${input.repo ?? ''}`
  if (tool === 'run_gate')            return `${input.repo ?? ''}@${input.branch ?? 'default'}`
  if (tool === 'check_gate')          return `${input.repo ?? ''} run ${input.run_id ?? ''}`
  if (tool === 'read_gate_logs')      return `${input.repo ?? ''} run ${input.run_id ?? ''}`
  try { return JSON.stringify(input).slice(0, 80) } catch { return '' }
}

function githubUrlForCall(call: ToolCall, repo: string | null, branch: string | null): string | null {
  const repoFromInput = (call.input.repo as string | undefined) || repo
  if (!repoFromInput) return null
  const ref = (call.input.branch as string | undefined) || (call.input.ref as string | undefined) || branch || 'HEAD'
  if (call.tool === 'read_github_file' || call.tool === 'write_github_file' || call.tool === 'delete_github_file') {
    const path = call.input.path as string | undefined
    if (!path) return `https://github.com/${repoFromInput}`
    return `https://github.com/${repoFromInput}/blob/${ref}/${path}`
  }
  if (call.tool === 'list_github_dir') {
    const path = (call.input.path as string | undefined) || ''
    return path
      ? `https://github.com/${repoFromInput}/tree/${ref}/${path}`
      : `https://github.com/${repoFromInput}`
  }
  if (call.tool === 'create_github_branch') {
    const newBranch = call.input.branch as string | undefined
    if (newBranch) return `https://github.com/${repoFromInput}/tree/${newBranch}`
    return `https://github.com/${repoFromInput}`
  }
  if (call.tool === 'web_fetch') return (call.input.url as string | undefined) ?? null
  if (call.tool === 'setup_gate_workflow') {
    return `https://github.com/${repoFromInput}/blob/${ref}/.github/workflows/holden-mercer-gate.yml`
  }
  if (call.tool === 'run_gate' || call.tool === 'check_gate' || call.tool === 'read_gate_logs') {
    return `https://github.com/${repoFromInput}/actions/workflows/holden-mercer-gate.yml`
  }
  return null
}

interface SseEvent { event: string; data: any }

function parseSseEvent(raw: string): SseEvent | null {
  let event = ''
  let data  = ''
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trim()
  }
  if (!event) return null
  try {
    return { event, data: data ? JSON.parse(data) : {} }
  } catch {
    return null
  }
}

// ── Session summaries ─────────────────────────────────────────────────────

function sessionFilename(): string {
  const d = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  return [
    d.getUTCFullYear(),
    pad(d.getUTCMonth() + 1),
    pad(d.getUTCDate()),
  ].join('-') + '-' + [
    pad(d.getUTCHours()),
    pad(d.getUTCMinutes()),
    pad(d.getUTCSeconds()),
  ].join('') + '.md'
}

function sessionMarkdown({
  projectName, userText, assistantText, toolCalls, model, autonomy,
}: {
  projectName:   string
  userText:      string
  assistantText: string
  toolCalls:     ToolCall[]
  model:         string
  autonomy:      string
}): string {
  const lines: string[] = []
  lines.push(`# Session — ${projectName}`)
  lines.push('')
  lines.push(`- **When**: ${new Date().toISOString()}`)
  lines.push(`- **Model**: ${model}`)
  lines.push(`- **Autonomy**: ${autonomy}`)
  lines.push('')
  lines.push('## User')
  lines.push('')
  lines.push(userText)
  lines.push('')
  lines.push('## Claude')
  lines.push('')
  lines.push(assistantText.trim() || '_(no text — see tool calls below)_')
  if (toolCalls.length > 0) {
    lines.push('')
    lines.push('## Tool calls')
    lines.push('')
    for (const c of toolCalls) {
      const status = c.status === 'ok' ? '✅' : c.status === 'error' ? '❌' : '◌'
      lines.push(`- ${status} \`${c.tool}\` — \`${JSON.stringify(c.input)}\``)
      if (c.status === 'error' && c.errorMsg) {
        lines.push(`  - error: ${c.errorMsg}`)
      }
    }
  }
  lines.push('')
  return lines.join('\n')
}
