/**
 * MarkdownEditor — resizable textarea with basic markdown syntax highlighting.
 *
 * Uses a transparent textarea layered over a highlighted <pre> backdrop.
 * Both scroll together. Supports light/dark themes via Tailwind dark: variants.
 */
import { useRef, useCallback, useEffect, useState } from 'react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  className?: string;
  spellCheck?: boolean;
}

/** Apply basic markdown syntax coloring via <span> tags. */
function highlightMarkdown(text: string): string {
  // Escape HTML first
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped
    .split('\n')
    .map(line => {
      // Headings: lines starting with one or more #
      if (/^#{1,6}\s/.test(line)) {
        return `<span class="md-heading">${line}</span>`;
      }
      // Horizontal rules: --- or ***
      if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
        return `<span class="md-hr">${line}</span>`;
      }
      // Bullet list items
      if (/^\s*[-*+]\s/.test(line)) {
        const match = line.match(/^(\s*[-*+]\s)/);
        if (match) {
          return `<span class="md-bullet">${match[1]}</span>${highlightInline(line.slice(match[1].length))}`;
        }
      }
      // Numbered list items
      if (/^\s*\d+\.\s/.test(line)) {
        const match = line.match(/^(\s*\d+\.\s)/);
        if (match) {
          return `<span class="md-bullet">${match[1]}</span>${highlightInline(line.slice(match[1].length))}`;
        }
      }
      return highlightInline(line);
    })
    .join('\n');
}

/** Highlight inline markdown: **bold**, *italic*, `code`, {{placeholders}} */
function highlightInline(text: string): string {
  return text
    // Bold: **text**
    .replace(/(\*\*)(.*?)\1/g, '<span class="md-bold">$1$2$1</span>')
    // Italic: *text* (but not inside **)
    .replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g, '<span class="md-italic">*$1*</span>')
    // Inline code: `text`
    .replace(/(`)(.*?)\1/g, '<span class="md-code">$1$2$1</span>')
    // Template placeholders: {{VAR}}
    .replace(/(\{\{.*?\}\})/g, '<span class="md-placeholder">$1</span>');
}

export default function MarkdownEditor({ value, onChange, rows = 24, className = '', spellCheck = false }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLPreElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  // Sync scroll positions
  const handleScroll = useCallback(() => {
    if (textareaRef.current && backdropRef.current) {
      backdropRef.current.scrollTop = textareaRef.current.scrollTop;
      backdropRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  // Observe textarea resize (user dragging the corner) and match backdrop height
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const observer = new ResizeObserver(() => {
      setHeight(ta.offsetHeight);
    });
    observer.observe(ta);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef} className={`md-editor-wrapper relative ${className}`}>
      {/* Highlighted backdrop */}
      <pre
        ref={backdropRef}
        className="md-editor-backdrop"
        style={height ? { height } : undefined}
        aria-hidden
        dangerouslySetInnerHTML={{ __html: highlightMarkdown(value) + '\n' }}
      />
      {/* Editable textarea (transparent text, visible caret) */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        onScroll={handleScroll}
        rows={rows}
        spellCheck={spellCheck}
        className="md-editor-textarea"
      />
    </div>
  );
}
