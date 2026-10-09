import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownView({ text }: { text: string }) {
  return (
    <div className="prose prose-sm prose-pig max-w-none">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => {
          // Knowledge base citations ([K1](#knowledge:chunk_…)) open the cited passage in-app.
          const chunk = href?.match(/^#knowledge:(chunk_[a-f0-9]{32})$/)?.[1];
          if (chunk)
            return (
              <a
                href={href}
                className="knowledge-cite text-accent"
                title="查看引用原文"
                onClick={(e) => {
                  e.preventDefault();
                  window.dispatchEvent(new CustomEvent("pig-knowledge-citation", { detail: chunk }));
                }}
              >
                {children}
              </a>
            );
          return (
            <a href={href} target="_blank" rel="noreferrer" className="text-accent">
              {children}
            </a>
          );
        },
        code: ({ className, children, ...props }) => {
          const inline = !className;
          if (inline) {
            return (
              <code className="rounded bg-ink-100 px-1 py-0.5 text-[12px] text-ink-800" {...props}>
                {children}
              </code>
            );
          }
          return (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
    </div>
  );
}
