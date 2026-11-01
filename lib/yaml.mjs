// The YAML subset and front-matter split of the data repo's check.mjs, so the
// site reads a file exactly as the check accepted it. Keep the two in step.

export function parseYaml(src) {
  const rows = src.split('\n').map((raw, i) => {
    const n = i + 1
    if (/^\s*(#.*)?$/.test(raw)) return { n, raw, blank: true }
    const lead = raw.match(/^[ \t]*/)[0]
    if (lead.includes('\t')) throw new Error(`line ${n}: indent with spaces, not tabs`)
    return { n, raw, indent: lead.length, text: raw.slice(lead.length).replace(/\s+$/, '') }
  })
  let pos = 0
  const peek = () => { while (pos < rows.length && rows[pos].blank) pos++; return rows[pos] }
  const isDash = t => t === '-' || t.startsWith('- ')
  const fail = (r, msg) => { throw new Error(`line ${r.n}: ${msg}`) }

  function block(r) {
    return isDash(r.text) ? list(r.indent) : map(r.indent)
  }
  function map(indent) {
    const out = {}
    for (let r = peek(); r && r.indent === indent && !isDash(r.text); r = peek()) {
      const m = r.text.match(/^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]+(.*))?$/)
      if (!m) fail(r, `expected "key: value", found "${r.text.slice(0, 40)}"`)
      if (Object.hasOwn(out, m[1])) fail(r, `"${m[1]}" appears twice`)
      pos++
      out[m[1]] = value(m[2] ?? '', r, indent)
    }
    const r = peek()
    if (r && r.indent > indent) fail(r, 'unexpected indentation')
    return out
  }
  function list(indent) {
    const out = []
    for (let r = peek(); r && r.indent === indent && isDash(r.text); r = peek()) {
      const rest = r.text.slice(1).replace(/^ +/, '')
      if (/^[A-Za-z_][\w-]*[ \t]*:([ \t]|$)/.test(rest)) {
        // "- key: value" opens a map whose keys line up with this first key.
        r.indent += r.text.length - rest.length
        r.text = rest
        out.push(map(r.indent))
      } else {
        pos++
        out.push(value(rest, r, indent))
      }
    }
    const r = peek()
    if (r && r.indent > indent) fail(r, 'unexpected indentation')
    return out
  }
  function value(text, row, indent) {
    text = text.trim()
    if (text === '' || text.startsWith('#')) {
      const r = peek()
      if (r && (r.indent > indent || (r.indent === indent && isDash(r.text)))) return block(r)
      return null
    }
    const c = text[0]
    if (c === '&' || c === '*' || c === '!') fail(row, 'anchors, aliases and tags are not supported')
    if (c === '{') fail(row, 'write this as indented "key: value" lines, not {…}')
    if (c === '|' || c === '>') {
      if (!/^[|>][-+]?$/.test(text)) fail(row, `unsupported block header "${text}"`)
      const lines = []
      while (pos < rows.length && (rows[pos].blank || rows[pos].indent > indent)) lines.push(rows[pos++].raw)
      while (lines.length && !lines.at(-1).trim()) lines.pop()
      const cut = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^ */)[0].length))
      const body = lines.map(l => l.slice(cut))
      return c === '|' ? body.join('\n') : body.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ')
    }
    if (c === '"' || c === "'") {
      // A quoted string may run over several lines: line breaks fold into spaces.
      let s = text
      for (;;) {
        const end = closingQuote(s, c)
        if (end !== -1) {
          const tail = s.slice(end + 1).trim()
          if (tail && !tail.startsWith('#')) fail(row, `unexpected text after the closing quote: "${tail.slice(0, 30)}"`)
          const inner = s.slice(1, end)
          if (c === "'") return inner.replace(/''/g, "'")
          try { return JSON.parse(`"${inner.replace(/\t/g, '\\t')}"`) } catch { fail(row, 'bad escape inside double quotes') }
        }
        if (pos >= rows.length) fail(row, 'this quoted string never closes')
        const next = rows[pos++]
        s += ' ' + next.raw.trim()
      }
    }
    if (c === '[') {
      if (!text.endsWith(']')) fail(row, 'a [list] must close on the same line')
      const inner = text.slice(1, -1).trim()
      return inner ? inner.split(',').map(x => scalar(x.trim().replace(/^(["'])(.*)\1$/, '$2'))) : []
    }
    // A plain string ends at " #" and may continue on more-indented lines.
    let s = text.replace(/\s+#.*$/, '')
    for (let r = peek(); r && r.indent > indent && !isDash(r.text) && !/^[A-Za-z_][\w-]*:(\s|$)/.test(r.text); r = peek()) {
      s += ' ' + r.text.replace(/\s+#.*$/, '')
      pos++
    }
    return scalar(s)
  }
  function closingQuote(s, q) {
    for (let i = 1; i < s.length; i++) {
      if (q === '"' && s[i] === '\\') { i++; continue }
      if (s[i] === q) {
        if (q === "'" && s[i + 1] === "'") { i++; continue }
        return i
      }
    }
    return -1
  }
  function scalar(s) {
    if (s === 'true') return true
    if (s === 'false') return false
    if (s === 'null' || s === '~' || s === '') return null
    if (/^-?\d+$/.test(s)) return Number(s)
    return s
  }

  const first = peek()
  if (!first) return {}
  if (first.indent !== 0) fail(first, 'the first key must start at the beginning of the line')
  const out = block(first)
  if (Array.isArray(out)) fail(first, 'the front matter must be "key: value" lines, not a list')
  const left = peek()
  if (left) fail(left, 'unexpected indentation')
  return out
}

export function splitFile(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (!text.startsWith('---\n')) throw new Error('the file must start with a "---" line')
  const end = text.indexOf('\n---', 3)
  const close = end === -1 ? -1 : text.slice(end + 4).search(/^[ \t]*(\n|$)/)
  if (end === -1 || close !== 0) throw new Error('the front matter must end with a "---" line')
  const yaml = text.slice(4, end + 1)
  const body = text.slice(end + 4).replace(/^[ \t]*\n?/, '')
  return { data: parseYaml(yaml), body }
}
