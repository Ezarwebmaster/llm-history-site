// Lab logos are data, not markup. A logo file is accepted only if it is a bare
// <svg viewBox> holding <path d> elements (plus an optional <title>); anything
// else (script, style, handlers, href, use, image, foreignObject, defs, text,
// gradients, comments, entities, unknown attributes) rejects the whole file and
// the page keeps the lab's monogram. A path is one flat colour: currentColor or
// a #hex value. The output is rebuilt from the parsed values, so nothing of the
// original markup reaches the page.
//
//   parseLogo(text)            -> { viewBox, paths: [{ d, fill, fillRule, clipRule, opacity }] }  (throws on anything else)
//   logoSymbol(id, logo)       -> '<symbol id="lg-…" viewBox="…"><path …/></symbol>'

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`
const VIEWBOX = new RegExp(`^${NUM}(?:[\\s,]+${NUM}){3}$`)
const PATH_D = /^[MmZzLlHhVvCcSsQqTtAa0-9eE.,+\-\s]{1,8000}$/
const RULE = /^(?:nonzero|evenodd)$/
const OPACITY = /^(?:0|1|0?\.\d+)$/
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const TAG = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[a-zA-Z][\w:-]*="[^"<>&]*")*)\s*(\/?)>/y
const ATTR = /\s+([a-zA-Z][\w:-]*)="([^"]*)"/g
// Attributes read, and attributes that may be present but are dropped (never copied).
const SVG_ATTRS = new Set(['viewBox', 'xmlns', 'fill', 'fill-rule', 'width', 'height', 'style', 'role'])
const PATH_ATTRS = new Set(['d', 'fill-rule', 'clip-rule', 'opacity', 'fill-opacity', 'fill'])

export function parseLogo(text) {
  if (typeof text !== 'string' || text.length > 20000) throw new Error('not a small text file')
  // An optional plain-text <title> is dropped first (the page shows the lab name as text).
  const s = text.replace(/^﻿/, '').replace(/<title>[^<&]{0,200}<\/title>/, '').trim()
  let i = 0, depth = 0, logo = null, closed = false
  while (i < s.length) {
    const ws = /\s*/y; ws.lastIndex = i; ws.exec(s); i = ws.lastIndex
    if (i >= s.length) break
    TAG.lastIndex = i
    const m = TAG.exec(s)
    if (!m) throw new Error(`unexpected content at ${i}: ${JSON.stringify(s.slice(i, i + 24))}`)
    i = TAG.lastIndex
    const [, end, name, attrText, self] = m
    const attrs = Object.fromEntries([...attrText.matchAll(ATTR)].map(a => [a[1], a[2]]))
    if (closed) throw new Error('content after </svg>')
    if (name === 'svg') {
      if (end) { if (depth !== 1) throw new Error('unbalanced </svg>'); depth = 0; closed = true; continue }
      if (logo || self) throw new Error('one <svg> root expected')
      for (const k of Object.keys(attrs)) if (!SVG_ATTRS.has(k)) throw new Error(`<svg ${k}> not allowed`)
      if (attrs.xmlns && attrs.xmlns !== 'http://www.w3.org/2000/svg') throw new Error('foreign xmlns')
      if (attrs.fill && !/^(?:currentColor|none|#000|#000000|black)$/.test(attrs.fill)) throw new Error('coloured <svg fill>: use the mono variant')
      const vb = (attrs.viewBox || '').trim()
      if (!VIEWBOX.test(vb)) throw new Error('missing or bad viewBox')
      logo = { viewBox: vb.split(/[\s,]+/).map(Number).join(' '), fillRule: RULE.test(attrs['fill-rule'] || '') ? attrs['fill-rule'] : null, paths: [] }
      depth = 1
    } else if (name === 'path') {
      if (end || depth !== 1) throw new Error('<path> must sit directly in <svg>')
      for (const k of Object.keys(attrs)) if (!PATH_ATTRS.has(k)) throw new Error(`<path ${k}> not allowed`)
      if (attrs.fill && attrs.fill !== 'currentColor' && !HEX.test(attrs.fill)) throw new Error('<path fill> must be currentColor or a #hex colour')
      const d = (attrs.d || '').trim()
      if (!PATH_D.test(d)) throw new Error('bad path data')
      const op = attrs.opacity ?? attrs['fill-opacity']
      if (op != null && !OPACITY.test(op)) throw new Error('bad opacity')
      logo.paths.push({ d: d.replace(/\s+/g, ' '), fill: HEX.test(attrs.fill || '') ? attrs.fill.toUpperCase() : null, fillRule: RULE.test(attrs['fill-rule'] || '') ? attrs['fill-rule'] : logo.fillRule, clipRule: RULE.test(attrs['clip-rule'] || '') ? attrs['clip-rule'] : null, opacity: op ?? null })
      if (!self) { // <path …></path>
        TAG.lastIndex = i; const c = TAG.exec(s)
        if (!c || c[1] !== '/' || c[2] !== 'path') throw new Error('<path> must be empty')
        i = TAG.lastIndex
      }
    } else throw new Error(`<${name}> not allowed`)
  }
  if (!logo || !closed) throw new Error('no complete <svg>')
  if (!logo.paths.length || logo.paths.length > 12) throw new Error('1 to 12 paths expected')
  return logo
}

export function logoSymbol(id, logo) {
  if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new Error('bad logo id')
  const path = p => `<path d="${p.d}"${p.fill ? ` fill="${p.fill}"` : ''}${p.fillRule ? ` fill-rule="${p.fillRule}"` : ''}${p.clipRule ? ` clip-rule="${p.clipRule}"` : ''}${p.opacity ? ` opacity="${p.opacity}"` : ''}/>`
  return `<symbol id="lg-${id}" viewBox="${logo.viewBox}">${logo.paths.map(path).join('')}</symbol>`
}
