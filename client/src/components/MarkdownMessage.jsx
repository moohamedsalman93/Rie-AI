import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTypewriter } from '../hooks/useTypewriter';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy, Check } from 'lucide-react';
import { useState, useEffect } from 'react';

/**
 * Component for rendering markdown content in chat messages
 */
const CopyButton = ({ code }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy code:', err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1.5 rounded-md hover:bg-neutral-700/50 text-neutral-400 hover:text-neutral-200 transition-colors"
      title="Copy code"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
};

export function MarkdownMessage({ content, className = "", isStreaming = false, typesWrite, setTypesWrite }) {
  const displayedText = useTypewriter(content, isStreaming);

  // Update parent state for auto-scrolling only when streaming
  useEffect(() => {
    if (isStreaming && setTypesWrite) {
      setTypesWrite(displayedText);
    }
  }, [displayedText, isStreaming, setTypesWrite]);

  return (
    <div className={`markdown-content ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Style headings
          h1: ({ node, ...props }) => <h1 className="text-base font-bold mb-2 mt-3 first:mt-0" {...props} />,
          h2: ({ node, ...props }) => <h2 className="text-sm font-bold mb-2 mt-3 first:mt-0" {...props} />,
          h3: ({ node, ...props }) => <h3 className="text-sm font-semibold mb-1.5 mt-2 first:mt-0" {...props} />,
          // Style paragraphs
          p: ({ node, ...props }) => <p className="mb-2 last:mb-0 leading-relaxed" {...props} />,
          // Style lists
          ul: ({ node, ...props }) => <ul className="list-disc list-inside mb-2 space-y-1 ml-2" {...props} />,
          ol: ({ node, ...props }) => <ol className="list-decimal list-inside mb-2 space-y-1 ml-2" {...props} />,
          li: ({ node, ...props }) => <li className="leading-relaxed" {...props} />,
          // Style code blocks
          code: ({ node, inline, className, children, ...props }) => {
            const match = /language-(\w+)/.exec(className || '');
            const language = match ? match[1] : '';
            const codeString = String(children).replace(/\n$/, '');

            if (inline || language == "") {
              return (
                <code className="px-1.5 py-0.5 rounded bg-neutral-900 text-green-500 font-mono text-xs border border-neutral-700/50" {...props}>
                  {children}
                </code>
              );
            }

            return (
              <div className="relative mb-4 group rounded-xl overflow-hidden border border-neutral-700/50">
                <div className="flex items-center justify-between px-4 py-2 bg-neutral-800/50 border-b border-neutral-700/50">
                  <span className="text-xs font-mono text-neutral-400 lowercase">{language || 'text'}</span>
                  <CopyButton code={codeString} />
                </div>
                <SyntaxHighlighter
                  style={atomDark}
                  language={language}
                  PreTag="div"
                  className="!bg-neutral-900/90 !p-4 !m-0 !rounded-none overflow-x-auto text-sm"
                  {...props}
                >
                  {codeString}
                </SyntaxHighlighter>
              </div>
            );
          },
          pre: ({ node, ...props }) => (
            <pre className="mb-2 overflow-x-auto max-w-[85%]" {...props} />
          ),
          // Style links
          a: ({ node, ...props }) => (
            <a
              className="text-neutral-300 hover:text-neutral-200 underline underline-offset-2 transition"
              target="_blank"
              rel="noopener noreferrer"
              {...props}
            />
          ),
          // Style blockquotes
          blockquote: ({ node, ...props }) => (
            <blockquote className="border-l-4 border-neutral-600/60 pl-3 py-1 my-2 italic text-neutral-300 bg-neutral-800/40 rounded-r" {...props} />
          ),
          // Style horizontal rules
          hr: ({ node, ...props }) => (
            <hr className="border-neutral-700/50 my-3" {...props} />
          ),
          // Style tables
          table: ({ node, ...props }) => (
            <div className="overflow-x-auto my-2">
              <table className="min-w-full border-collapse border border-neutral-700/50" {...props} />
            </div>
          ),
          thead: ({ node, ...props }) => (
            <thead className="bg-neutral-800/60" {...props} />
          ),
          tbody: ({ node, ...props }) => (
            <tbody {...props} />
          ),
          tr: ({ node, ...props }) => (
            <tr className="border-b border-neutral-700/40" {...props} />
          ),
          th: ({ node, ...props }) => (
            <th className="border border-neutral-700/50 px-2 py-1 text-left font-semibold text-neutral-200" {...props} />
          ),
          td: ({ node, ...props }) => (
            <td className="border border-neutral-700/50 px-2 py-1 text-neutral-300" {...props} />
          ),
          // Style strong and emphasis
          strong: ({ node, ...props }) => (
            <strong className="font-semibold" {...props} />
          ),
          em: ({ node, ...props }) => (
            <em className="italic" {...props} />
          ),
        }}
      >
        {displayedText}
      </ReactMarkdown>
    </div>
  );
}
