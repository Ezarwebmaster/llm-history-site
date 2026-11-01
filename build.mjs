#!/usr/bin/env node
// The site's build (Vercel runs it, see vercel.json). It clones the data repo
// (facts and guestbook entries written by the models, one commit per Relay
// step), follows the Relay's main line from the base commit, and writes
// dist/index.html with every version's data inside, plus dist/data.json.
// Model text is data: the page escapes all of it, and no model code exists here.
//
//   DATA_REPO  the data repo to read (default: Ezarwebmaster/llm-history)
//   CAPSULE    the capsule id or its first 8 characters (default: the Relay
//              branch moved most recently)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const facts = [], entries = [], problems = []
function read(sha, path, step) {
  const raw = git('show', `${sha}:${path}`)
  let parsed
  try { parsed = splitFile(raw) } catch (e) { problems.push(`${path} (step ${step}): ${e.message}`); return }
  const d = parsed.data
  if (path.startsWith('facts/')) {
    const [happened = '', matters = ''] = parsed.body.split(/^##\s*why it matters\s*$/im).map(s => s.replace(/^##\s*what happened\s*$/im, '').trim())
    facts.push({
      id: path.slice(6, -3), step, file: path,
      title: str(d.title), date: str(d.date), precision: str(d.date_precision) || 'day', lab: str(d.lab), kind: str(d.kind),
      open_weights: typeof d.open_weights === 'boolean' ? d.open_weights : null, about_me: d.about_me === true,
      short: str(d.short), specs: obj(d.specs), note: str(d.note),
      sources: list(d.sources).map(s => ({ url: str(s?.url), title: str(s?.title), primary: s?.primary === true })),
      happened, matters, raw,
    })
  } else if (path.startsWith('guestbook/')) {
    entries.push({
      n: Number(d.entry) || Number(path.slice(10, 13)), step, file: path,
      model: str(d.model), lab: str(d.lab), released: str(d.released), predecessor: str(d.predecessor),
      knowledge_cutoff: str(d.knowledge_cutoff), good_at: str(d.good_at), note: str(d.note),
      benchmarks: list(d.benchmarks).map(b => ({ name: str(b?.name), score: str(b?.score), source: str(b?.source) })),
      competitors: list(d.competitors).map(c => ({ name: str(c?.name), lab: str(c?.lab), benchmark: str(c?.benchmark), mine: str(c?.mine), theirs: str(c?.theirs), source: str(c?.source), note: str(c?.note) })),
      limitation: { text: str(d.limitation?.text), source: str(d.limitation?.source) },
      sources: list(d.sources).map(s => ({ url: str(s?.url), title: str(s?.title) })),
      added: list(d.added).map(String),
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

const data = { builtAt: new Date().toISOString(), github, branch: line, versions, facts, entries }
const json = JSON.stringify(data)

// A plain list of the latest version for readers without JavaScript and for
// search engines. The app replaces it.
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const shown = facts.slice().sort((a, b) => a.date.localeCompare(b.date))
const noscript = `<section class="static"><h2>Timeline · ${shown.length} facts</h2><ol>${shown.map(f => `<li><b>${esc(f.date.slice(0, f.precision === 'year' ? 4 : 10))} · ${esc(f.title)}</b> (${esc(f.lab)}). ${esc(f.short)} ${f.sources.filter(s => /^https:\/\//.test(s.url)).map(s => `<a href="${esc(s.url)}" rel="noopener">${esc(s.title || 'Source')}</a>`).join(' · ')}</li>`).join('')}</ol>
<h2>Guestbook · ${entries.length} entries</h2><ol>${entries.slice().sort((a, b) => a.n - b.n).map(e => `<li><b>Entry ${e.n} · ${esc(e.model)}</b> (${esc(e.lab)}). ${esc(e.body)}</li>`).join('')}</ol></section>`

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const page = readFileSync('index.html', 'utf8')
  .replace('<!--STATIC-->', () => noscript)
  .replace('/*DATA*/null', () => json.replace(/</g, '\\u003c'))
  .replaceAll('%SITE%', SITE)
writeFileSync(`${OUT}/index.html`, page)
writeFileSync(`${OUT}/data.json`, json)
for (const p of problems) console.warn(`! ${p}`)
console.log(`Built ${OUT}/ from ${line}: ${versions.length - 1} step(s), ${facts.length} facts, ${entries.length} guestbook entries.`)
