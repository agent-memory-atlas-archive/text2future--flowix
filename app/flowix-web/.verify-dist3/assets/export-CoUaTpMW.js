import{D as a}from"./agent-session-store-DmXa1o5u.js";import{f_ as r}from"./index-Ds2nF888.js";import"./window-BvQMTvAN.js";const m=/^\uFEFF?(?:[ \t]*\r?\n)*---\r?\n[\s\S]*?\r?\n---\r?\n?/,l=120,d=new a({gfm:!0,breaks:!1,async:!1}),s={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"},f=new Set(["\\","/",":","*","?",'"',"<",">","|"]),c=new Set(Array.from({length:32},(e,o)=>String.fromCharCode(o))),p=`
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.7;
    color: #1f2328;
    background: #ffffff;
    padding: 32px 40px;
  }
  h1, h2, h3, h4, h5, h6 {
    margin: 1.4em 0 0.6em;
    line-height: 1.3;
    font-weight: 600;
  }
  h1 { font-size: 1.8em; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.3em; }
  h2 { font-size: 1.45em; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.25em; }
  h3 { font-size: 1.2em; }
  h4 { font-size: 1.05em; }
  p { margin: 0.6em 0; }
  a { color: #2563eb; text-decoration: none; }
  ul, ol { padding-left: 1.6em; margin: 0.6em 0; }
  li + li { margin-top: 0.2em; }
  blockquote {
    margin: 0.8em 0;
    padding: 0.2em 1em;
    color: #57606a;
    border-left: 3px solid #d0d7de;
    background: #f6f8fa;
  }
  code {
    font-family: "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", "DengXian", "等线", "Microsoft YaHei", "微软雅黑", monospace;
    font-size: 0.9em;
    background: rgba(175, 184, 193, 0.2);
    padding: 0.15em 0.35em;
    border-radius: 4px;
  }
  pre {
    background: #f6f8fa;
    padding: 14px 16px;
    border-radius: 6px;
    overflow-x: auto;
    line-height: 1.5;
  }
  pre code { background: transparent; padding: 0; font-size: 0.875em; }
  table {
    border-collapse: collapse;
    margin: 0.8em 0;
    display: block;
    overflow-x: auto;
  }
  th, td {
    border: 1px solid #d0d7de;
    padding: 6px 12px;
    text-align: left;
  }
  th { background: #f6f8fa; font-weight: 600; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.5em 0; }
  img { max-width: 100%; height: auto; }
  input[type="checkbox"] { margin-right: 6px; }
  @media print {
    body { padding: 0; }
    pre, blockquote { page-break-inside: avoid; }
    h1, h2, h3, h4 { page-break-after: avoid; }
  }
`;function g(e){return e.replace(m,"").replace(/^\s+/,"")}function w(e){return d.parse(g(e))}function h(e){return e.replace(/[&<>"']/g,o=>s[o]??o)}function E(e,o,n){const t=r(n,"common.untitled");return`<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<title>${h(e||t)}</title>
<!--[if gte mso 9]>
<xml>
  <w:WordDocument>
    <w:View>Print</w:View>
    <w:Zoom>100</w:Zoom>
    <w:DoNotOptimizeForBrowser/>
  </w:WordDocument>
</xml>
<![endif]-->
<style>${p}</style>
</head>
<body>
<main>${o}</main>
</body>
</html>`}function k(e,o){const n=(e||"").split("").map(t=>c.has(t)||f.has(t)?"_":t).join("").replace(/\s+/g," ").trim().slice(0,l);return n||r(o,"common.untitled")}export{E as buildWordHtml,w as markdownToHtml,k as sanitizeFileName,g as stripFrontmatter};
