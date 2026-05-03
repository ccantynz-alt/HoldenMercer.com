/**
 * Console — the actual builder chat surface.
 *
 * Streams from POST /api/console/stream as SSE. Renders text deltas live,
 * shows tool calls inline as they happen. Per-project history persists to
 * localStorage. Native textarea so OS dictation (iPad mic, Mac fn-fn,
 * Win+H) Just Works — no custom STT layer.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useChat, newChatId, type ChatMessage, type ToolCall } from '../stores/chat'
import { useProjects } from '../stores/projects'
import { useSettings } from '../stores/settings'
import { useAuth } from '../stores/auth'

interface Props {
  projectId: string
}

export function Console({ projectId }: Props) {
  const project       = useProjects((s) => s.projects.find((p) => p.id === projectId))
  const messages      = useChat((s) => s.threads[projectId] ?? [])
  const appendMessage = useChat((s) => s.appendMessage)
  const patchMessage  = useChat((s) => s.patchMessage)
  const appendTool    = useChat((s) => s.appendToolCall)
  const patchTool     = useChat((s) => s.patchToolCall)
  const clearThread   = useChat((s) => s.clearThread)

  const settings = useSettings()
  const token    = useAuth((s) => s.token)

  const [input,    setInput]    = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Auto-scroll to bottom on every message change (simple, works for now)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  const ready = useMemo(() => {
    return Boolean(settings.anthropicKey && project)
  }, [settings.anthropicKey, project])

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

    // Pre-create the assistant message so deltas have somewhere to land
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

    // Build the request payload
    const systemPrompt = buildSystemPrompt(project.name, project.description)
    const apiMessages  = [...messages, userMessage].map(toApiMessage)

    const ac = new AbortController()
    abortRef.current = ac
    let accumulatedText = ''

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
          tools_enabled:  ['web_fetch', 'read_github_file', 'list_github_repos'],
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

        // Parse SSE events: blank-line separated, each event = "event: X\ndata: Y\n"
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
          } else if (event.event === 'tool_use_result') {
            patchTool(projectId, assistantId, event.data.id, {
              status:  'ok',
              preview: event.data.output ?? '',
            })
          } else if (event.event === 'tool_use_error') {
            patchTool(projectId, assistantId, event.data.id, {
              status:   'error',
              errorMsg: event.data.error ?? 'unknown error',
            })
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
      {/* Conversation */}
      <div className="hm-console-thread" ref={scrollRef}>
        {messages.length === 0 ? (
          <ConsoleEmpty
            ready={ready}
            hasKey={Boolean(settings.anthropicKey)}
            hasGithub={Boolean(settings.githubToken)}
          />
        ) : (
          messages.map((m) => <MessageRow key={m.id} message={m} />)
        )}
      </div>

      {/* Composer */}
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
            {streaming ? 'Streaming…' : `Model: ${settings.defaultModel} · Autonomy: ${settings.autonomy}`}
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

function MessageRow({ message }: { message: ChatMessage }) {
  return (
    <div className={`hm-msg hm-msg-${message.role}`}>
      <div className="hm-msg-role">{message.role === 'user' ? 'You' : 'Claude'}</div>
      <div className="hm-msg-body">
        {message.text ? (
          <div className="hm-msg-text">{message.text}</div>
        ) : message.streaming && message.toolCalls.length === 0 ? (
          <div className="hm-msg-text hm-msg-thinking">…thinking</div>
        ) : null}

        {message.toolCalls.map((c) => <ToolCallRow key={c.id} call={c} />)}

        {message.streaming && (
          <span className="hm-msg-cursor" aria-hidden>▍</span>
        )}
      </div>
    </div>
  )
}

function ToolCallRow({ call }: { call: ToolCall }) {
  const summary = summariseInput(call.tool, call.input)
  return (
    <details className={`hm-tool hm-tool-${call.status}`} open={call.status === 'running'}>
      <summary>
        <span className="hm-tool-icon">{call.status === 'running' ? '◌' : call.status === 'ok' ? '●' : '✕'}</span>
        <span className="hm-tool-name">{call.tool}</span>
        <span className="hm-tool-summary">{summary}</span>
      </summary>
      {call.status === 'error' ? (
        <pre className="hm-tool-output hm-tool-error-output">{call.errorMsg}</pre>
      ) : call.preview ? (
        <pre className="hm-tool-output">{call.preview}</pre>
      ) : null}
    </details>
  )
}

function ConsoleEmpty(
  { ready, hasKey, hasGithub }: { ready: boolean; hasKey: boolean; hasGithub: boolean }
) {
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
          Tip: add a GitHub PAT in Settings so Claude can read files from your other
          repos via the <code>read_github_file</code> tool.
        </p>
      )}
      {ready && (
        <p className="hm-console-empty-body">
          Ask anything about <em>this</em> project — Claude reads the brief automatically.
          Paste a URL and it'll fetch the page. Mention another repo and it can read files
          from there.
        </p>
      )}
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildSystemPrompt(name: string, description: string): string {
  const parts = [
    `You are the build agent for the project "${name}".`,
    description.trim()
      ? `\nProject brief:\n${description.trim()}`
      : `\nThe project brief is empty. If you need clarity, ask the user to fill it in via the Brief tab.`,
    '\nYou have read-only tools available: web_fetch (any URL), read_github_file (any GitHub repo), list_github_repos (the user\'s repos). Use them whenever they would help.',
    '\nWriting tools (file edits, commits, deploys) are not yet wired in — propose changes as code blocks and the user will apply them. PR C will give you direct write access.',
    '\nBe concise. Skip preamble. When asked to plan, give a numbered plan with file paths and the actual change, not abstract advice.',
  ]
  return parts.join('\n')
}

function toApiMessage(m: ChatMessage): { role: 'user' | 'assistant'; content: string | unknown[] } {
  // The backend conversation history we send back is just the text. Tool-use blocks
  // were already round-tripped server-side during the stream — we don't replay them.
  return { role: m.role === 'system' ? 'user' : m.role, content: m.text }
}

function summariseInput(tool: string, input: Record<string, unknown>): string {
  if (tool === 'web_fetch')        return String(input.url ?? '')
  if (tool === 'read_github_file') return `${input.repo ?? ''}/${input.path ?? ''}${input.ref ? `@${input.ref}` : ''}`
  if (tool === 'list_github_repos') return input.search ? `search="${input.search}"` : 'all repos'
  try { return JSON.stringify(input).slice(0, 80) } catch { return '' }
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
