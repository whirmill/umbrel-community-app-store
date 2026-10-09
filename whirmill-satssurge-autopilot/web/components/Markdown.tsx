import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeUrl } from "../../src/ui-client";
const plugins = [remarkGfm];
const components = {
  img: () => null,
  a: ({ href, children }: any) =>
    safeUrl(href ?? "") ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  pre: ({ children }: any) => <pre tabIndex={0}>{children}</pre>,
  table: ({ children }: any) => (
    <div
      className="markdown-table"
      tabIndex={0}
      role="region"
      aria-label="Tabella"
    >
      <table>{children}</table>
    </div>
  ),
};
export function Mark({ children }: { children: string }) {
  return (
    <div className="markdown">
      <Markdown
        skipHtml
        remarkPlugins={plugins}
        urlTransform={(url) => safeUrl(url) ?? ""}
        components={components}
      >
        {children}
      </Markdown>
    </div>
  );
}
