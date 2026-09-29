import http from 'http'
import crypto from 'crypto'

const PORT = Number(process.env.PORT || 3000)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Hub-Signature-256',
  'Cache-Control': 'no-store',
}

const mem = {
  msgs: new Map(),
  idxPending: new Set(),
  idxProcessed: new Set(),
}

function json(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extraHeaders })
  res.end(body)
}

function text(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain', ...CORS_HEADERS, ...extraHeaders })
  res.end(body)
}

function notFound(res) {
  json(res, 404, { ok: false, error: 'not_found' })
}

function now() {
  return Date.now()
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function putMessage(msg) {
  mem.msgs.set(msg.id, msg)
  if (msg.status === 'pending') {
    mem.idxPending.add(msg.id)
    mem.idxProcessed.delete(msg.id)
  } else {
    mem.idxProcessed.add(msg.id)
    mem.idxPending.delete(msg.id)
  }
}

function listMessages(status) {
  const ids = status === 'processed' ? mem.idxProcessed : mem.idxPending
  const out = []
  ids.forEach((id) => {
    const v = mem.msgs.get(id)
    if (v) out.push(v)
  })
  out.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
  return out
}

function markProcessed(id) {
  const v = mem.msgs.get(id)
  if (!v) return false
  v.status = 'processed'
  mem.msgs.set(id, v)
  mem.idxPending.delete(id)
  mem.idxProcessed.add(id)
  return true
}

function verifySignature(rawBody, signature) {
  const appSecret = process.env.WHATSAPP_APP_SECRET
  if (!appSecret) return true
  if (!signature) return false
  const hash = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')
  const expected = `sha256=${hash}`
  return signature === expected
}

function normalizeInboundMessage(msg) {
  const id = String(msg?.id || crypto.randomUUID())
  const from = String(msg?.from || '')
  const type = String(msg?.type || 'unknown')

  let textValue = ''
  let media = undefined

  if (type === 'text') {
    textValue = String(msg?.text?.body || '')
  } else if (type === 'image' || type === 'video' || type === 'audio' || type === 'document' || type === 'sticker') {
    const block = msg?.[type] || {}
    const mediaId = block?.id ? String(block.id) : ''
    const caption = block?.caption ? String(block.caption) : ''
    const filename = block?.filename ? String(block.filename) : undefined
    const mime_type = block?.mime_type ? String(block.mime_type) : undefined
    const sha256 = block?.sha256 ? String(block.sha256) : undefined

    media = {
      id: mediaId,
      type,
      caption,
      filename,
      mime_type,
      sha256,
    }

    textValue = caption ? `[${type}] ${caption}` : `[${type}]`
  } else if (type === 'interactive') {
    textValue = '[interactive]'
  } else if (type === 'button') {
    textValue = '[button]'
  } else if (type === 'reaction') {
    textValue = '[reaction]'
  } else if (type === 'location') {
    const loc = msg?.location || {}
    const name = loc?.name ? String(loc.name) : ''
    textValue = name ? `[location] ${name}` : '[location]'
  } else {
    textValue = `[${type}]`
  }

  return {
    id,
    timestamp: now(),
    from,
    to: undefined,
    type,
    text: textValue,
    status: 'pending',
    raw: msg,
    media,
  }
}

async function graphFetch(path, init) {
  const version = process.env.WHATSAPP_GRAPH_VERSION || 'v24.0'
  const token = process.env.WHATSAPP_TOKEN
  if (!token) throw new Error('not_configured')
  const url = `https://graph.facebook.com/${version}${path}`
  const headers = {
    ...(init?.headers || {}),
    Authorization: `Bearer ${token}`,
  }
  return fetch(url, { ...init, headers })
}

async function handleSend(req, res) {
  const buf = await readBody(req)
  const ct = String(req.headers['content-type'] || '').toLowerCase()

  let to = ''
  let textMsg = ''
  let type = 'text'
  let link = ''
  let mediaId = ''
  let caption = ''
  let filename = ''
  let mimeType = ''
  let dataBase64 = ''

  if (ct.includes('application/json')) {
    let body = {}
    try {
      body = JSON.parse(buf.toString('utf8') || '{}')
    } catch {}

    to = String(body?.to || '').trim()
    textMsg = String((typeof body?.text === 'string' ? body.text : body?.message) || '').trim()
    type = String(body?.type || (body?.media ? 'media' : 'text')).trim() || 'text'

    // Media options
    link = String(body?.link || body?.url || body?.media?.link || '').trim()
    mediaId = String(body?.media_id || body?.media?.id || '').trim()
    caption = String(body?.caption || body?.media?.caption || '').trim()
    filename = String(body?.filename || body?.media?.filename || '').trim()
    mimeType = String(body?.mime_type || body?.media?.mime_type || '').trim()
    dataBase64 = String(body?.data_base64 || body?.media?.data_base64 || '').trim()
  } else {
    const raw = buf.toString('utf8')
    const sp = new URLSearchParams(raw)
    to = String(sp.get('to') || '').trim()
    textMsg = String(sp.get('text') || sp.get('message') || '').trim()
  }

  if (!to) return json(res, 400, { ok: false, error: 'invalid_params', message: 'Missing to.' })

  const version = process.env.WHATSAPP_GRAPH_VERSION || 'v24.0'
  const token = process.env.WHATSAPP_TOKEN
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  if (!token || !phoneNumberId) return json(res, 500, { ok: false, error: 'not_configured' })

  const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`

  let payload
  const mediaTypes = new Set(['image', 'video', 'audio', 'document', 'sticker'])

  if (type === 'text' || (!mediaId && !link && textMsg)) {
    if (!textMsg) return json(res, 400, { ok: false, error: 'invalid_params', message: 'Missing text.' })
    payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: textMsg } }
  } else if (mediaTypes.has(type)) {
    // Optional: upload base64 to get a media id
    if (!mediaId && !link && dataBase64) {
      const mime = mimeType || 'application/octet-stream'
      const fname = filename || `upload-${Date.now()}`
      const uploadId = await uploadMediaFromBase64(dataBase64, fname, mime)
      mediaId = uploadId
    }

    const block = {}
    if (mediaId) block.id = mediaId
    else if (link) block.link = link
    else return json(res, 400, { ok: false, error: 'invalid_params', message: 'Missing media_id or link.' })

    if (caption && (type === 'image' || type === 'video' || type === 'document')) block.caption = caption
    if (filename && type === 'document') block.filename = filename

    payload = { messaging_product: 'whatsapp', to, type, [type]: block }
  } else {
    // Default: treat as text
    if (!textMsg) return json(res, 400, { ok: false, error: 'invalid_params', message: 'Missing text.' })
    payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: textMsg } }
  }

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const respText = await r.text().catch(() => '')
  let respJson = null
  try {
    respJson = JSON.parse(respText)
  } catch {
    respJson = { raw: respText }
  }

  if (!r.ok) return json(res, r.status, { ok: false, status: r.status, response: respJson })
  return json(res, 200, { ok: true, data: respJson })
}

async function uploadMediaFromBase64(dataBase64, filename, mimeType) {
  const version = process.env.WHATSAPP_GRAPH_VERSION || 'v24.0'
  const token = process.env.WHATSAPP_TOKEN
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID
  if (!token || !phoneNumberId) throw new Error('not_configured')

  const buf = Buffer.from(dataBase64, 'base64')
  const blob = new Blob([buf], { type: mimeType || 'application/octet-stream' })
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('file', blob, filename || `upload-${Date.now()}`)

  const url = `https://graph.facebook.com/${version}/${phoneNumberId}/media`
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })

  const t = await r.text().catch(() => '')
  let j
  try { j = JSON.parse(t) } catch { j = { raw: t } }
  if (!r.ok) throw new Error(`media_upload_failed:${r.status}`)
  const id = j?.id ? String(j.id) : ''
  if (!id) throw new Error('media_upload_missing_id')
  return id
}

async function handleWebhooks(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (req.method === 'GET') {
    const token = url.searchParams.get('hub.verify_token')
    const challenge = url.searchParams.get('hub.challenge')
    const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN
    if (token && expected && token === expected && challenge) return text(res, 200, challenge)
    return text(res, 403, 'invalid')
  }

  if (req.method !== 'POST') return text(res, 405, 'method_not_allowed', { Allow: 'GET, POST, OPTIONS' })

  const buf = await readBody(req)
  const raw = buf.toString('utf8')
  const signature = String(req.headers['x-hub-signature-256'] || '')

  if (!verifySignature(raw, signature || null)) return text(res, 403, 'invalid_signature')

  let payload = {}
  try {
    payload = JSON.parse(raw || '{}')
  } catch {}

  try {
    const entries = payload.entry || []
    for (const entry of entries) {
      const changes = entry.changes || []
      for (const change of changes) {
        const value = change.value || {}

        const messages = value.messages || []
        for (const msg of messages) {
          const m = normalizeInboundMessage(msg)
          putMessage(m)
        }
      }
    }
  } catch {}

  return json(res, 200, { ok: true })
}

async function handleMessages(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const statusRaw = String(url.searchParams.get('status') || 'pending').toLowerCase()
  const status = statusRaw === 'processed' ? 'processed' : 'pending'
  return json(res, 200, { ok: true, status, messages: listMessages(status) })
}

async function handleAck(req, res, id) {
  const ok = markProcessed(id)
  return json(res, 200, { ok: true, id, processed: ok })
}

async function handleMedia(req, res, mediaId) {
  const version = process.env.WHATSAPP_GRAPH_VERSION || 'v24.0'
  const token = process.env.WHATSAPP_TOKEN
  if (!token) return json(res, 500, { ok: false, error: 'not_configured' })

  // 1) Ask Graph for a download URL
  const infoUrl = `https://graph.facebook.com/${version}/${encodeURIComponent(mediaId)}`
  const infoRes = await fetch(infoUrl, { headers: { Authorization: `Bearer ${token}` } })
  const infoText = await infoRes.text().catch(() => '')
  if (!infoRes.ok) {
    let infoJson
    try { infoJson = JSON.parse(infoText) } catch { infoJson = { raw: infoText } }
    return json(res, infoRes.status, { ok: false, error: 'media_info_failed', response: infoJson })
  }

  let info
  try { info = JSON.parse(infoText) } catch { info = {} }
  const dlUrl = info?.url
  const mime = info?.mime_type

  if (!dlUrl) return json(res, 500, { ok: false, error: 'media_url_missing' })

  // 2) Download binary
  const binRes = await fetch(dlUrl, { headers: { Authorization: `Bearer ${token}` } })
  if (!binRes.ok) {
    const t = await binRes.text().catch(() => '')
    return json(res, binRes.status, { ok: false, error: 'media_download_failed', response: t })
  }

  const ab = await binRes.arrayBuffer()
  const buf = Buffer.from(ab)
  const contentType = binRes.headers.get('content-type') || mime || 'application/octet-stream'
  const contentLength = binRes.headers.get('content-length') || String(buf.length)

  res.writeHead(200, {
    ...CORS_HEADERS,
    'Content-Type': contentType,
    'Content-Length': contentLength,
  })
  res.end(buf)
}

async function handleMediaUpload(req, res) {
  const buf = await readBody(req)
  let body = {}
  try { body = JSON.parse(buf.toString('utf8') || '{}') } catch {}

  const dataBase64 = String(body?.data_base64 || '').trim()
  const filename = String(body?.filename || '').trim() || `upload-${Date.now()}`
  const mimeType = String(body?.mime_type || '').trim() || 'application/octet-stream'
  if (!dataBase64) return json(res, 400, { ok: false, error: 'invalid_params', message: 'Missing data_base64.' })

  try {
    const id = await uploadMediaFromBase64(dataBase64, filename, mimeType)
    return json(res, 200, { ok: true, id })
  } catch (e) {
    return json(res, 500, { ok: false, error: 'upload_failed', message: String(e?.message || e || 'unknown') })
  }
}

const server = http.createServer(async (req, res) => {
  try {
    // Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }

    const url = new URL(req.url, `http://${req.headers.host}`)
    const pathname = url.pathname

    if (pathname === '/api/health' || pathname === '/api/whatsapp/health') {
      if (req.method === 'HEAD') {
        res.writeHead(200, CORS_HEADERS)
        res.end()
        return
      }
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET, HEAD, OPTIONS' })

      const debug = url.searchParams.get('debug')
      if (debug === '1') {
        const envToken = process.env.WHATSAPP_TOKEN || ''
        const envSuffix = envToken ? envToken.slice(-8) : null
        const envPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || null
        const gv = process.env.WHATSAPP_GRAPH_VERSION || null
        return json(res, 200, { ok: true, debug: { env_token_suffix: envSuffix, phone_number_id: envPhoneId, graph_version: gv } })
      }
      return json(res, 200, { ok: true })
    }

    if (pathname === '/api/whatsapp/send') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST, OPTIONS' })
      return await handleSend(req, res)
    }

    if (pathname === '/api/whatsapp/webhooks' || pathname === '/api/whatsapp/webhook') {
      return await handleWebhooks(req, res)
    }

    if (pathname === '/api/whatsapp/messages') {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET, OPTIONS' })
      return await handleMessages(req, res)
    }

    const ackMatch = pathname.match(/^\/api\/whatsapp\/messages\/([^\/]+)\/ack$/)
    if (ackMatch) {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST, OPTIONS' })
      return await handleAck(req, res, decodeURIComponent(ackMatch[1]))
    }

    const mediaMatch = pathname.match(/^\/api\/whatsapp\/media\/([^\/]+)$/)
    if (mediaMatch) {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET, OPTIONS' })
      return await handleMedia(req, res, decodeURIComponent(mediaMatch[1]))
    }

    if (pathname === '/api/whatsapp/media/upload') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST, OPTIONS' })
      return await handleMediaUpload(req, res)
    }

    return notFound(res)
  } catch (e) {
    return json(res, 500, { ok: false, error: 'server_error', message: String(e?.message || e || 'unknown') })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[render] Listening on :${PORT}`)
})
