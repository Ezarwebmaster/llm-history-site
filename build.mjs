#!/usr/bin/env node
// The site's build (Vercel runs it, see vercel.json). It clones the data repo
// (facts and guestbook entries written by the models, one commit per Relay
// step), follows the Relay's main line from the base commit, and writes
// dist/index.html with every version's data inside, plus dist/data.json.
// A revision (facts/<year>-<slug>-rev<N>.md, replaces: <id>) is a later version of
// a fact: it goes to `revisions`, and the page shows the last one of each fact.
// Model text is data: the page escapes all of it, and no model code exists here.
//
//   DATA_REPO  the data repo to read (default: Ezarwebmaster/llm-history)
//   CAPSULE    the capsule id or its first 8 characters (default: the Relay
//              branch moved most recently)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { logoSymbol, parseLogo } from './lib/logo.mjs'
import { splitFile } from './lib/yaml.mjs'

const DATA_REPO = process.env.DATA_REPO || 'https://github.com/Ezarwebmaster/llm-history.git'
const CACHE = '.cache/data.git'
const OUT = 'dist'
const VIA = /\s*\(via LLM TimeMachine\)\s*$/
const SITE = 'https://history.llmtimemachine.com/'

const run = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] })
const git = (...args) => run('--git-dir', CACHE, ...args)
const tryGit = (...args) => { try { return git(...args) } catch { return '' } }

// Every branch of the data repo, fresh on each build.
if (existsSync(CACHE)) git('fetch', '--quiet', '--prune', DATA_REPO, '+refs/heads/*:refs/heads/*')
else { mkdirSync('.cache', { recursive: true }); run('clone', '--quiet', '--bare', DATA_REPO, CACHE) }
const slug = DATA_REPO.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1] ?? null
const github = slug ? `https://github.com/${slug}` : null

// The Relay's main line: relay/<capsule>/main.
const relays = git('for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/relay/').split('\n')
  .filter(r => /^relay\/[0-9a-f]{8}\/main$/.test(r))
const wanted = (process.env.CAPSULE || '').trim().slice(0, 8)
const line = (wanted && relays.find(r => r === `relay/${wanted}/main`)) || relays[0] || 'main'
if (wanted && line !== `relay/${wanted}/main`) console.warn(`No branch relay/${wanted}/main: showing ${line}.`)

const chain = git('rev-list', '--reverse', '--first-parent', line).trim().split('\n').filter(Boolean)
const meta = sha => {
  const [author, date, message] = git('show', '-s', '--format=%an%x1f%aI%x1f%B', sha).split('\x1f')
  return { author, date, message: message.trim() }
}
const first = chain.findIndex(sha => VIA.test(meta(sha).author))
const baseSha = first === -1 ? chain.at(-1) : chain[first - 1]
const stepShas = first === -1 ? [] : chain.slice(first).filter(sha => VIA.test(meta(sha).author))

// Lab names as the models spelled them, folded into one name per lab for the filters.
// The file as written keeps its own spelling (the drawer shows it).
const LAB_ALIASES = {
  Moonshot: 'Moonshot AI', MoonshotAI: 'Moonshot AI', 'Zhipu AI': 'Z.ai (Zhipu AI)', Zhipu: 'Z.ai (Zhipu AI)', 'Z.ai': 'Z.ai (Zhipu AI)',
  'Amazon Web Services': 'Amazon', AWS: 'Amazon', 'Alibaba (Qwen)': 'Alibaba', 'Alibaba Cloud': 'Alibaba', Qwen: 'Alibaba',
  'Google DeepMind': 'Google', 'Google Brain': 'Google', 'Google Research': 'Google',
  'Facebook AI': 'Meta', 'Facebook AI Research': 'Meta', FAIR: 'Meta', 'Meta AI': 'Meta', Mistral: 'Mistral AI', Nvidia: 'NVIDIA',
  SpaceXAI: 'xAI', 'Microsoft AI': 'Microsoft',
}
const labName = v => Object.hasOwn(LAB_ALIASES, str(v)) ? LAB_ALIASES[str(v)] : str(v)

// Lab logos, next to the lab's name on the timeline, the drawer and the guestbook
// (the KPI panel keeps monograms). Each mark is drawn as its owner draws it: one-colour
// marks in black, colour marks in their own flat colours, never recoloured.
// Not listed on purpose: Meta, Microsoft, Apple and IBM (their logos need a
// licence), MiniMax (its mark is a gradient) and Tencent (no standalone mark
// checked against its own). Removing a line puts the monogram back. Files and
// their sha256 are in logos/SOURCES.json.
const LAB_LOGOS = {
  OpenAI: 'openai', Anthropic: 'anthropic', xAI: 'xai', 'Z.ai (Zhipu AI)': 'zai', 'Moonshot AI': 'moonshot', 'Liquid AI': 'liquid',
  Google: 'google', 'Mistral AI': 'mistral', NVIDIA: 'nvidia', DeepSeek: 'deepseek', Cohere: 'cohere', Alibaba: 'alibaba',
}

const facts = [], revisions = [], entries = [], problems = []
function read(sha, path, step) {
  const raw = git('show', `${sha}:${path}`)
  let parsed
  try { parsed = splitFile(raw) } catch (e) { problems.push(`${path} (step ${step}): ${e.message}`); return }
  const d = parsed.data
  if (path.startsWith('facts/')) {
    const [happened = '', matters = ''] = parsed.body.split(/^##\s*why it matters\s*$/im).map(s => s.replace(/^##\s*what happened\s*$/im, '').trim())
    const replaces = typeof d.replaces === 'string' && /^\d{4}-[a-z0-9-]+$/.test(d.replaces) ? d.replaces : null
    ;(replaces ? revisions : facts).push({
      id: path.slice(6, -3), step, file: path, ...(replaces ? { of: replaces, rev: Number(path.match(/-rev(\d+)\.md$/)?.[1]) || 0 } : {}),
      title: str(d.title), date: str(d.date), precision: str(d.date_precision) || 'day', lab: labName(d.lab), kind: str(d.kind),
      open_weights: typeof d.open_weights === 'boolean' ? d.open_weights : null, about_me: d.about_me === true,
      short: str(d.short), specs: obj(d.specs), note: str(d.note),
      sources: list(d.sources).map(s => ({ url: str(s?.url), title: str(s?.title), primary: s?.primary === true })),
      happened, matters, raw,
    })
  } else if (path.startsWith('guestbook/')) {
    entries.push({
      n: Number(d.entry) || Number(path.slice(10, 13)), step, file: path,
      model: str(d.model), lab: labName(d.lab), released: str(d.released), predecessor: str(d.predecessor),
      knowledge_cutoff: str(d.knowledge_cutoff), good_at: str(d.good_at), note: str(d.note),
      benchmarks: list(d.benchmarks).map(b => ({ name: str(b?.name), score: str(b?.score), source: str(b?.source) })),
      competitors: list(d.competitors).map(c => ({ name: str(c?.name), lab: labName(c?.lab), benchmark: str(c?.benchmark), mine: str(c?.mine), theirs: str(c?.theirs), source: str(c?.source), note: str(c?.note) })),
      limitation: { text: str(d.limitation?.text), source: str(d.limitation?.source) },
      sources: list(d.sources).map(s => ({ url: str(s?.url), title: str(s?.title) })),
      added: list(d.added).map(String), revised: list(d.revised).map(String),
      checked: list(d.checked).map(c => ({ fact: c?.fact != null ? String(c.fact) : null, entry: Number.isInteger(c?.entry) ? c.entry : null, verdict: str(c?.verdict), field: str(c?.field), was: str(c?.was), now: str(c?.now), note: str(c?.note), source: str(c?.source) })),
      body: parsed.body.trim(), raw,
    })
  }
}
function str(v) { return v == null ? '' : typeof v === 'object' ? '' : String(v) }
function list(v) { return Array.isArray(v) ? v : [] }
function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, str(x)])) : null }
const dataFile = p => /^(facts|guestbook)\/[^/]+\.md$/.test(p)

// The base: every data file it holds. A step: the files it added (steps only add).
for (const p of git('ls-tree', '-r', '--name-only', baseSha).split('\n').filter(dataFile)) read(baseSha, p, 0)
const versions = [{ n: 0, sha: baseSha, date: meta(baseSha).date }]
stepShas.forEach((sha, i) => {
  const n = i + 1, m = meta(sha)
  const lines = m.message.split('\n')
  const trailer = key => lines.find(l => l.startsWith(`${key}:`))?.slice(key.length + 1).trim() || null
  const tail = lines.findIndex(l => /^(Model|Capsule|Checks|Broken|Kind|Fixes):/.test(l))
  const changelog = lines.slice(1, tail === -1 ? undefined : tail).map(l => l.replace(/^[-*]\s+/, '').trim()).filter(Boolean)
  versions.push({ n, sha, date: m.date, author: m.author.replace(VIA, ''), modelId: trailer('Model'), checks: trailer('Checks'), capsule: trailer('Capsule'), changelog })
  for (const row of git('diff-tree', '--no-commit-id', '-r', '--name-status', '--no-renames', sha).split('\n').filter(Boolean)) {
    const [status, path] = row.split('\t')
    if (!dataFile(path)) continue
    if (status === 'A') read(sha, path, n)
    else problems.push(`${path}: ${status === 'D' ? 'deleted' : 'changed'} at step ${n}, ignored`)
  }
})

// Revisions hang on their fact; a check may name a revision's id, which leads to the
// same fact (c.version keeps the id it named).
const factIds = new Set(facts.map(f => f.id))
for (const r of revisions.filter(r => !factIds.has(r.of))) problems.push(`${r.file} (step ${r.step}): replaces ${r.of}, which is not a fact, ignored`)
revisions.splice(0, revisions.length, ...revisions.filter(r => factIds.has(r.of)).sort((a, b) => a.step - b.step || a.rev - b.rev))
const origOf = new Map(revisions.map(r => [r.id, r.of]))
for (const e of entries) for (const c of e.checked) if (c.fact && origOf.has(c.fact)) Object.assign(c, { version: c.fact, fact: origOf.get(c.fact) })

// The logos of the labs in the data. A file that is missing, edited since it was
// vendored (sha256) or refused by lib/logo.mjs leaves that lab on its monogram.
const sha256 = Object.fromEntries(Object.values(JSON.parse(readFileSync('logos/SOURCES.json', 'utf8'))).flatMap(p => Object.entries(p.files).map(([id, f]) => [id, f.sha256])))
const logos = {}, symbols = []
for (const lab of new Set([...facts.map(f => f.lab), ...revisions.map(r => r.lab), ...entries.flatMap(e => [e.lab, ...e.competitors.map(c => c.lab)])])) {
  if (!Object.hasOwn(LAB_LOGOS, lab)) continue
  const id = LAB_LOGOS[lab]
  try {
    const raw = readFileSync(`logos/${id}.svg`)
    if (createHash('sha256').update(raw).digest('hex') !== sha256[id]) throw new Error('sha256 differs from logos/SOURCES.json')
    if (!Object.values(logos).includes(id)) symbols.push(logoSymbol(id, parseLogo(raw.toString('utf8'))))
    logos[lab] = id
  } catch (e) { problems.push(`logos/${id}.svg (${lab}): ${e.message}, monogram shown`) }
}

const data = { builtAt: new Date().toISOString(), github, branch: line, versions, facts, revisions, entries, logos }
const json = JSON.stringify(data)

// A plain list of the latest version for readers without JavaScript and for
// search engines. The app replaces it.
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
// Each fact in its last version, with the guestbook's corrections since that
// version applied, as the page shows them. Checks made at the step of a
// revision were made on the version before it.
const lastRev = new Map(revisions.map(r => [r.of, r]))
const fixedDate = new Map(), flag = new Map()
for (const e of entries.slice().sort((a, b) => a.step - b.step)) for (const c of e.checked) {
  if (!c.fact || e.step <= (lastRev.get(c.fact)?.step ?? -1)) continue
  if (c.verdict === 'corrected' && c.field === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(c.now)) fixedDate.set(c.fact, c.now)
  if (c.verdict === 'disputed' || c.verdict === 'corrected') flag.set(c.fact, flag.get(c.fact) === 'disputed' ? 'disputed' : c.verdict)
}
const shown = facts.map(f => {
  const v = lastRev.get(f.id)
  return { ...f, ...(v ? { title: v.title, date: v.date, precision: v.precision, lab: v.lab, short: v.short, sources: v.sources } : {}), revised: v ? v.rev : 0, date: fixedDate.get(f.id) || (v || f).date }
}).sort((a, b) => a.date.localeCompare(b.date))
const titleOf = Object.fromEntries(facts.map(f => [f.id, f.title]))
const modelOf = Object.fromEntries(entries.map(e => [e.n, e.model]))
const flagged = entries.slice().sort((a, b) => b.step - a.step).flatMap(e => e.checked.filter(c => c.verdict === 'corrected' || c.verdict === 'disputed').map(c => ({ ...c, by: e.model, step: e.step })))
const noscript = `<section class="static"><h2>Timeline · ${shown.length} facts</h2><ol>${shown.map(f => `<li><b>${esc(f.date.slice(0, f.precision === 'year' ? 4 : f.precision === 'month' ? 7 : 10))} · ${esc(f.title)}</b> (${esc(f.lab)}${f.revised ? `, revision ${f.revised}` : ''}${flag.has(f.id) ? `, ${flag.get(f.id)} by a later model` : ''}). ${esc(f.short)} ${f.sources.filter(s => /^https:\/\//.test(s.url)).map(s => `<a href="${esc(s.url)}" rel="noopener">${esc(s.title || 'Source')}</a>`).join(' · ')}</li>`).join('')}</ol>
<h2>Corrections and disputes · ${flagged.length}</h2><ol>${flagged.map(c => `<li><b>${c.verdict === 'corrected' ? 'Corrected' : 'Disputed'} at step ${c.step} by ${esc(c.by)}:</b> ${c.fact ? esc(titleOf[c.fact] || c.fact) : `guestbook entry ${c.entry}${modelOf[c.entry] ? ` (${esc(modelOf[c.entry])})` : ''}`}${c.field ? `, ${esc(c.field)}` : ''}${c.verdict === 'corrected' ? ` ${esc(c.was)} → ${esc(c.now)}` : ''}. ${esc(c.note)}</li>`).join('')}</ol>
<h2>Guestbook · ${entries.length} entries</h2><ol>${entries.slice().sort((a, b) => a.n - b.n).map(e => `<li><b>Entry ${e.n} · ${esc(e.model)}</b> (${esc(e.lab)}). ${esc(e.body)}</li>`).join('')}</ol></section>`

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const page = readFileSync('index.html', 'utf8')
  .replace('<!--STATIC-->', () => noscript)
  .replace('<!--LOGOS-->', () => symbols.join(''))
  .replace('/*DATA*/null', () => json.replace(/</g, '\\u003c'))
  .replaceAll('%SITE%', SITE)
writeFileSync(`${OUT}/index.html`, page)
writeFileSync(`${OUT}/data.json`, json)
for (const p of problems) console.warn(`! ${p}`)
console.log(`Built ${OUT}/ from ${line}: ${versions.length - 1} step(s), ${facts.length} facts, ${revisions.length} revision(s), ${entries.length} guestbook entries.`)
