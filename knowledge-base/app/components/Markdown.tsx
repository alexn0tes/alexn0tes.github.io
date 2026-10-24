import { Fragment, type ReactNode } from "react";

export function headingId(index: number) { return `section-${index}`; }
export function getHeadings(content: string) {
  let fenced = false;
  const items: { text: string; level: number; id: string }[] = [];
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim().startsWith("```")) { fenced = !fenced; continue; }
    const match = !fenced && line.match(/^(#{1,3})\s+(.+)$/);
    if (match) items.push({ text: match[2].replace(/[*`]/g, ""), level: match[1].length, id: headingId(items.length) });
  }
  return items;
}

// Retain the starter's helper shape for callers that use the original API.
export function headings(content: string) {
  return getHeadings(content).map(({ level, ...heading }) => ({ ...heading, depth: level }));
}

function safeLink(value: string) {
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  if (value.startsWith("#")) return value;
  try { const url = new URL(value); return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

function inline(text: string): ReactNode[] {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^\s)]+\))/g;
  const pieces: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) pieces.push(text.slice(last, index));
    const value = match[0];
    if (value.startsWith("`")) pieces.push(<code key={index}>{value.slice(1, -1)}</code>);
    else if (value.startsWith("**")) pieces.push(<strong key={index}>{value.slice(2, -2)}</strong>);
    else {
      const link = value.match(/^\[([^\]]+)\]\((.+)\)$/)!;
      const href = safeLink(link[2]);
      pieces.push(href ? <a key={index} href={href} target={href.startsWith("#") ? undefined : "_blank"} rel={href.startsWith("#") ? undefined : "noopener noreferrer"}>{link[1]}</a> : <Fragment key={index}>{link[1]}</Fragment>);
    }
    last = index + value.length;
  }
  if (last < text.length) pieces.push(text.slice(last));
  return pieces;
}

export function Markdown({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let headingIndex = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (line.trim().startsWith("```")) {
      const start = index;
      const language = line.trim().slice(3).trim();
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index].trim().startsWith("```")) code.push(lines[index++]);
      index++;
      blocks.push(<div className="code-block" key={start}>{language && <div className="code-language">{language}</div>}<pre><code>{code.join("\n")}</code></pre></div>);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const id = headingId(headingIndex++);
      const value = inline(heading[2]);
      blocks.push(heading[1].length === 1 ? <h2 key={index} id={id}>{value}</h2> : heading[1].length === 2 ? <h3 key={index} id={id}>{value}</h3> : <h4 key={index} id={id}>{value}</h4>);
      index++; continue;
    }
    if (/^\s*([-*_])\1\1+\s*$/.test(line)) { blocks.push(<hr key={index} />); index++; continue; }
    if (/^>\s?/.test(line)) {
      const start = index;
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={start}>{quote.map((value, i) => <p key={i}>{inline(value)}</p>)}</blockquote>); continue;
    }
    if (/^\s*(?:[-*+] |\d+\. )/.test(line)) {
      const start = index;
      const ordered = /^\s*\d+\. /.test(line);
      const list: ReactNode[] = [];
      while (index < lines.length && (ordered ? /^\s*\d+\. / : /^\s*[-*+] /).test(lines[index])) {
        const text = lines[index].replace(/^\s*(?:[-*+] |\d+\. )/, "");
        const check = text.match(/^\[([ xX])\]\s+(.*)/);
        list.push(<li key={index++}>{check ? <><span className={`markdown-check ${check[1] !== " " ? "checked" : ""}`} aria-label={check[1] !== " " ? "已完成" : "未完成"}>{check[1] !== " " ? "✓" : ""}</span>{inline(check[2])}</> : inline(text)}</li>);
      }
      blocks.push(ordered ? <ol key={start}>{list}</ol> : <ul key={start}>{list}</ul>); continue;
    }
    const start = index;
    const paragraph: string[] = [line];
    index++;
    while (index < lines.length && lines[index].trim() && !lines[index].trim().startsWith("```") && !/^(#{1,3}\s|>\s?|\s*(?:[-*+] |\d+\. ))/.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push(<p key={start}>{paragraph.map((value, i) => <Fragment key={i}>{i > 0 && <br />}{inline(value)}</Fragment>)}</p>);
  }
  return <div className="markdown-body">{blocks}</div>;
}

export default Markdown;
