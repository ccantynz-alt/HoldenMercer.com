/**
 * Markdown — renders Claude's text content with syntax-highlighted code blocks.
 *
 * Uses react-markdown + remark-gfm (tables / strikethrough / task lists) +
 * rehype-highlight (highlight.js). Streaming-safe: re-rendering on every
 * delta is fine because react-markdown uses keys per node.
 *
 * Code blocks get a discreet copy button.
 */

import { useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

interface Props {
  text: string
}

export function Markdown({ text }: Props) {
  return (
    <div className="hm-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">{children}</a>
          ),
          pre: ({ children }) => <PreWithCopy>{children}</PreWithCopy>,
          // Keep inline `code` simple — only style block code via the parent <pre>
          code: ({ className, children, ...rest }) => (
            <code className={className} {...rest}>{children}</code>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function PreWithCopy({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const codeText = extractText(children)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch { /* best-effort */ }
  }
  return (
    <div className="hm-md-pre-wrap">
      <button className="hm-md-copy" onClick={onCopy} aria-label="Copy code">
        {copied ? 'copied' : 'copy'}
      </button>
      <pre>{children}</pre>
    </div>
  )
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return extractText((node as { props: { children?: ReactNode } }).props.children)
  }
  return ''
}
