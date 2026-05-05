/**
 * Chat store — per-project message history.
 *
 * Persisted to localStorage so a refresh doesn't lose your conversation.
 * Each project has an independent thread. PR C will sync these to the
 * project's GitHub repo (the repo IS the memory) so they survive devices.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ChatRole  = 'user' | 'assistant' | 'system'
export type ChatAgent = 'claude' | 'architect' | 'coder' | 'reviewer'

/** Inline tool-call record so we can render it next to the message that triggered it. */
export interface ToolCall {
  id:         string
  tool:       string
  input:      Record<string, unknown>
  status:     'running' | 'ok' | 'error'
  preview?:   string         // truncated output for display
  errorMsg?:  string
}

export interface ChatAttachment {
  /** Stable id for keying / removal. */
  id:         string
  /** image/png, image/jpeg, image/gif, image/webp. */
  mediaType:  string
  /** Base64-encoded image data, no `data:` prefix. */
  base64:     string
  /** Original filename (for display). */
  name:       string
  /** Bytes (for display + size limit checks). */
  size:       number
}

export interface ChatMessage {
  id:        string
  role:      ChatRole
  text:      string                // markdown-friendly text body
  attachments?: ChatAttachment[]   // images attached to user messages
  toolCalls: ToolCall[]            // tool calls made *during* this assistant turn
  createdAt: number
  /** Optional persona — defaults to 'claude'. Used by the multi-agent swarm. */
  agent?:    ChatAgent
  /** The assistant message is still streaming when this is true. */
  streaming?: boolean
  /** Set once the turn finishes, e.g. 'end_turn' | 'tool_use' | 'max_tokens'. */
  stopReason?: string
}

interface ChatState {
  /** projectId → messages */
  threads: Record<string, ChatMessage[]>
  /** projectId → text the Console should pre-fill into the composer on next mount. */
  pendingInputs: Record<string, string>
  appendMessage:    (projectId: string, message: ChatMessage) => void
  patchMessage:     (projectId: string, id: string, patch: Partial<ChatMessage>) => void
  appendToolCall:   (projectId: string, messageId: string, call: ToolCall) => void
  patchToolCall:    (projectId: string, messageId: string, callId: string, patch: Partial<ToolCall>) => void
  clearThread:      (projectId: string) => void
  setPendingInput:  (projectId: string, text: string) => void
  consumePendingInput: (projectId: string) => string | null
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

export const useChat = create<ChatState>()(
  persist(
    (set, get) => ({
      threads: {},
      pendingInputs: {},

      setPendingInput: (projectId, text) => set((s) => ({
        pendingInputs: { ...s.pendingInputs, [projectId]: text },
      })),

      consumePendingInput: (projectId) => {
        const text = get().pendingInputs[projectId] ?? null
        if (text !== null) {
          set((s) => {
            const next = { ...s.pendingInputs }
            delete next[projectId]
            return { pendingInputs: next }
          })
        }
        return text
      },

      appendMessage: (projectId, message) => set((s) => ({
        threads: {
          ...s.threads,
          [projectId]: [...(s.threads[projectId] ?? []), message],
        },
      })),

      patchMessage: (projectId, id, patch) => set((s) => ({
        threads: {
          ...s.threads,
          [projectId]: (s.threads[projectId] ?? []).map((m) =>
            m.id === id ? { ...m, ...patch } : m
          ),
        },
      })),

      appendToolCall: (projectId, messageId, call) => set((s) => ({
        threads: {
          ...s.threads,
          [projectId]: (s.threads[projectId] ?? []).map((m) =>
            m.id === messageId ? { ...m, toolCalls: [...m.toolCalls, call] } : m
          ),
        },
      })),

      patchToolCall: (projectId, messageId, callId, patch) => set((s) => ({
        threads: {
          ...s.threads,
          [projectId]: (s.threads[projectId] ?? []).map((m) =>
            m.id === messageId
              ? { ...m, toolCalls: m.toolCalls.map((c) => c.id === callId ? { ...c, ...patch } : c) }
              : m
          ),
        },
      })),

      clearThread: (projectId) => set((s) => {
        const next = { ...s.threads }
        delete next[projectId]
        return { threads: next }
      }),
    }),
    { name: 'holdenmercer:chat:v1' }
  )
)

export { newId as newChatId }
