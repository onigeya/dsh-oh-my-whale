
import fs from "node:fs";
const run = process.argv[2];
const md = fs.readFileSync(run + "/research.md", "utf8");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s) => {
  let x = esc(s);
  x = x.replace(/\x60([^\x60]+)\x60/g, (m, c) => "<code>" + c + "</code>");
  x = x.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  x = x.replace(/\[(\d+)\]/g, '<a class="cite" href="#src-$1">[$1]</a>');
  x = x.replace(/(^|[^"(>])(https?:\/\/[^\s<)]+)/g, (m, p, u) => p + '<a href="' + u + '">' + u + "</a>");
  return x;
};
const fmEnd = md.indexOf("\n---\n", 4);
const fm = md.slice(4, fmEnd);
const body = md.slice(fmEnd + 5);
const fmv = {};
for (const line of fm.split("\n")) {
  const m = line.match(/^([a-z_]+):\s*'?(.*?)'?$/);
  if (m) fmv[m[1]] = m[2];
}
const lines = body.split("\n");
const out = [];
let i = 0;
let secN = 0;
const toc = [];
const badges = [
  [/研究对象|地址核实/, "verified", "gh API 实测"],
  [/宿主基线/, "verified", "本机文档直读"],
  [/维度 [1-4] ·/, "medium", "代码直读 · 未运行"],
  [/维度 5 ·/, "low", "含预印本与不可复现项"],
  [/交叉洞察/, "low", "含二手源与单一预印本"],
  [/开放问题/, "medium", "证据 + 产品判断"],
  [/建议：/, "medium", "依据前文证据"],
  [/反证清单/, "medium", "逐条核对宣称与代码"]
];
const badgeFor = (h) => { for (const [re, cls, label] of badges) if (re.test(h)) return { cls, label }; return null; };
const slug = (s) => s.replace(/[^\w\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

let seenBody = 0;
while (i < lines.length) {
  const line = lines[i];
  if (/^# /.test(line)) { i++; continue; }
  if (/^\*\*Decision this research serves:\*\*/.test(line)) { i++; continue; }
  if (/^## /.test(line)) {
    const h = line.slice(3).trim();
    secN++;
    const id = "sec-" + secN;
    toc.push([id, h]);
    const b = badgeFor(h);
    out.push('<h2 id="' + id + '">' + inline(h) + (b ? ' <span class="badge ' + b.cls + '">' + b.label + "</span>" : "") + "</h2>");
    i++;
    continue;
  }
  if (/^### /.test(line)) {
    const h = line.slice(4).trim();
    out.push('<h3 id="' + slug(h) + '">' + inline(h) + "</h3>");
    i++;
    continue;
  }
  if (/^\|/.test(line)) {
    const rows = [];
    while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
    const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const head = cells(rows[0]);
    const data = rows.slice(2).map(cells);
    const isSources = rows[0].includes("来源") && rows[0].includes("版本锚点");
    if (isSources) {
      const ap = fs.readFileSync(run + "/imports/sources-appendix.html", "utf8").replace(/\\`([^`]+)`/g, "<code>$1</code>");
      out.push('<details class="appendix" open><summary>来源表（30 条，点击编号回到引用处对照）</summary>' + ap + "</details>");
      continue;
    }
    let t = '<div class="tw"><table><thead><tr>' + head.map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr></thead><tbody>";
    for (const r of data) t += "<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>";
    out.push(t + "</tbody></table></div>");
    continue;
  }
  if (/^[-*] /.test(line)) {
    const items = [];
    while (i < lines.length && /^[-*] /.test(lines[i])) { items.push(lines[i].slice(2)); i++; }
    out.push("<ul>" + items.map((s) => "<li>" + inline(s) + "</li>").join("") + "</ul>");
    continue;
  }
  if (/^\d+\. /.test(line)) {
    const items = [];
    while (i < lines.length && /^\d+\. /.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s+/, "")); i++; }
    out.push("<ol>" + items.map((s) => "<li>" + inline(s) + "</li>").join("") + "</ol>");
    continue;
  }
  if (/^> /.test(line)) { out.push("<blockquote>" + inline(line.slice(2)) + "</blockquote>"); i++; continue; }
  if (line.trim() === "") { i++; continue; }
  const para = [];
  while (i < lines.length && lines[i].trim() !== "" && !/^(## |### |\| |[-*] |\d+\. |> )/.test(lines[i])) { para.push(lines[i]); i++; }
  const text = para.join(" ");
  const lead = /^\*\*(结论先行|一句话结论|需要产品侧决策|先看哪个)/.test(text);
  out.push('<p' + (lead ? ' class="lead"' : "") + ">" + inline(text) + "</p>");
}

const old = fs.readFileSync(run + "/research-briefing.html", "utf8");
const prefix = old.slice(0, old.indexOf('<nav class="toc">')).replace(/<nav[\s\S]*$/, "");
const footer = "\n</div>\n" + old.slice(old.indexOf("<script>"));
const nav = '<nav class="toc"><strong>目录</strong>\n' + toc.map(([id, h]) => '<a href="#' + id + '">' + esc(h.length > 28 ? h.slice(0, 28) + "…" : h) + "</a>").join("\n") + "\n</nav>\n<main>\n";
const html = prefix
  .replace(/<nav[\s\S]*?<\/nav>\s*/, "")
  .replace("<main>", "")
  .replace(/<\/main>/g, "")
  + nav + out.join("\n") + "\n" + footer;
fs.writeFileSync(run + "/research-briefing.html", html, "utf8");
fs.writeFileSync(run + "/imports/toc.json", JSON.stringify(toc, null, 1), "utf8");
console.log("bytes", html.length, "h2", toc.length, "blocks", out.length, "badges", (html.match(/class="badge /g) || []).length);
