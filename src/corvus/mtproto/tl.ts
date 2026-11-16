/* eslint-disable @typescript-eslint/no-explicit-any */
import * as zlib from 'zlib'

/** ---- CRC32 (untuk ID konstruktor TL) ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
export function crc32(buf: Buffer | string): number {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export const ID_VECTOR = 0x1cb5c415
export const ID_GZIP = 0x3072cfa1
export const ID_CONTAINER = 0x73f1f8dc
export const ID_RPC_RESULT = 0xf35c6d01
const ID_TRUE = 0x997275b5
const ID_FALSE = 0xbc799737

/** ---- Writer / Reader ---- */
export class Writer {
  private parts: Buffer[] = []
  raw(b: Buffer) { this.parts.push(b); return this }
  int(v: number) { const b = Buffer.alloc(4); b.writeInt32LE(v | 0); return this.raw(b) }
  uint(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return this.raw(b) }
  long(v: bigint | number | string) {
    const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt.asIntN(64, BigInt(v))); return this.raw(b)
  }
  double(v: number) { const b = Buffer.alloc(8); b.writeDoubleLE(v); return this.raw(b) }
  bytes(data: Buffer) {
    const l = data.length
    const head = l < 254 ? Buffer.from([l]) : Buffer.from([254, l & 255, (l >> 8) & 255, (l >> 16) & 255])
    const pad = (4 - ((head.length + l) % 4)) % 4
    return this.raw(Buffer.concat([head, data, Buffer.alloc(pad)]))
  }
  string(s: string | Buffer) { return this.bytes(typeof s === 'string' ? Buffer.from(s, 'utf8') : s) }
  done() { return Buffer.concat(this.parts) }
}

export class Reader {
  o = 0
  constructor(public b: Buffer) {}
  get left() { return this.b.length - this.o }
  int() { const v = this.b.readInt32LE(this.o); this.o += 4; return v }
  uint() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v }
  long() { const v = this.b.readBigInt64LE(this.o); this.o += 8; return v }
  double() { const v = this.b.readDoubleLE(this.o); this.o += 8; return v }
  raw(n: number) {
    if (this.o + n > this.b.length) throw new TLError('Reader: data habis')
    const v = this.b.subarray(this.o, this.o + n); this.o += n; return v
  }
  bytes() {
    let l = this.b[this.o++]!
    let head = 1
    if (l === 254) { l = this.b[this.o]! | (this.b[this.o + 1]! << 8) | (this.b[this.o + 2]! << 16); this.o += 3; head = 4 }
    const v = this.raw(l)
    this.o += (4 - ((head + l) % 4)) % 4
    return Buffer.from(v)
  }
  string() { return this.bytes().toString('utf8') }
  peekUint() { return this.b.readUInt32LE(this.o) }
}

export class TLError extends Error { constructor(m: string) { super(m); this.name = 'TLError' } }

/** ---- Schema ---- */
export interface TypeRef { name: string; args?: TypeRef[]; bare?: boolean }
export interface Param { name: string; type: TypeRef; flagField?: string; flagBit?: number }
export interface Ctor {
  id: number; name: string; params: Param[]; result: TypeRef; isFn: boolean; resultName: string
}

const BUILTIN = new Set(['int', 'long', 'double', 'string', 'bytes', 'vector', 'int128', 'int256', 'Vector', 'Int', 'Long', 'Double', 'String', 'Bytes', 'Int128', 'Int256'])

export function parseType(s: string): TypeRef {
  s = s.trim()
  if (s.startsWith('!')) s = s.slice(1)
  const bare = s.startsWith('%')
  if (bare) s = s.slice(1)
  const m = /^([Vv]ector)<(.+)>$/.exec(s)
  if (m) return { name: 'Vector', args: [parseType(m[2]!)], bare: m[1] === 'vector' }
  return { name: s, bare }
}

export class Schema {
  byId = new Map<number, Ctor>()
  byName = new Map<string, Ctor>()
  layer?: number

  load(text: string) {
    const lay = /\/\/\s*LAYER\s+(\d+)/.exec(text)
    if (lay) this.layer = Number(lay[1])
    let fn = false
    for (let raw of text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')) {
      raw = raw.replace(/\/\/.*$/, '').trim()
      if (!raw) continue
      if (raw.startsWith('---')) { fn = /functions/.test(raw); continue }
      const m = /^([\w.]+)(?:#([0-9a-fA-F]{1,8}))?\s*(.*?)\s*=\s*([\w.<>%]+)\s*;?$/.exec(raw)
      if (!m) continue
      const [, name, hex, rest, result] = m as unknown as string[]
      if (BUILTIN.has(name!)) continue
      const params: Param[] = []
      for (const tok of rest!.split(/\s+/).filter(Boolean)) {
        if (tok.startsWith('{') || tok === '[' || tok === ']' || tok === '*') continue
        const i = tok.indexOf(':')
        if (i < 0) continue
        const pname = tok.slice(0, i)
        let t = tok.slice(i + 1)
        let flagField: string | undefined, flagBit: number | undefined
        const f = /^(\w+)\.(\d+)\?(.+)$/.exec(t)
        if (f) { flagField = f[1]; flagBit = Number(f[2]); t = f[3]! }
        params.push({ name: pname, type: t === '#' ? { name: '#' } : parseType(t), flagField, flagBit })
      }
      const id = hex
        ? parseInt(hex, 16) >>> 0
        : crc32(raw.replace(/;$/, '').replace(/[<>]/g, ' ').replace(/[{}]/g, '').replace(/:bytes\b/g, ':string').replace(/\s+/g, ' ').trim())
      const c: Ctor = { id, name: name!, params, result: parseType(result!), isFn: fn, resultName: result! }
      this.byName.set(c.name, c)
      if (!fn) this.byId.set(c.id, c) // fungsi tidak pernah dibaca dari server
    }
    return this
  }

  get size() { return this.byName.size }

  /* ---- serialize ---- */
  serialize(obj: any): Buffer {
    const w = new Writer()
    this.writeObject(w, obj)
    return w.done()
  }

  private writeObject(w: Writer, obj: any) {
    if (obj instanceof Uint8Array && !(obj as any)._) { w.raw(Buffer.from(obj)); return } // sudah ter-serialize
    const c = this.byName.get(obj?._)
    if (!c) throw new TLError(`Konstruktor/metode TL tidak dikenal: ${obj?._}`)
    w.uint(c.id)
    this.writeParams(w, c, obj)
  }

  writeParams(w: Writer, c: Ctor, obj: any) {
    const flags: Record<string, number> = {}
    for (const p of c.params) {
      if (p.flagField && obj[p.name] !== undefined && obj[p.name] !== null && obj[p.name] !== false) {
        flags[p.flagField] = (flags[p.flagField] ?? 0) | (1 << p.flagBit!)
      }
    }
    for (const p of c.params) {
      if (p.type.name === '#') { w.uint(flags[p.name] ?? 0); continue }
      const v = obj[p.name]
      if (p.flagField) {
        if (v === undefined || v === null || v === false) continue
        if (p.type.name === 'true') continue
      }
      if (v === undefined || v === null) throw new TLError(`Parameter wajib hilang: ${c.name}.${p.name}`)
      this.writeType(w, p.type, v)
    }
  }

  private writeType(w: Writer, t: TypeRef, v: any) {
    switch (t.name) {
      case 'int': return void w.int(Number(v))
      case 'long': return void w.long(v)
      case 'double': return void w.double(Number(v))
      case 'string': return void w.string(v)
      case 'bytes': return void w.bytes(Buffer.isBuffer(v) ? v : Buffer.from(v))
      case 'int128': if (v.length !== 16) throw new TLError('int128 harus 16 byte'); return void w.raw(v)
      case 'int256': if (v.length !== 32) throw new TLError('int256 harus 32 byte'); return void w.raw(v)
      case 'Bool': return void w.uint(v ? ID_TRUE : ID_FALSE)
      case 'true': return
      case 'Vector': {
        if (!t.bare) w.uint(ID_VECTOR)
        w.int(v.length)
        for (const it of v) this.writeType(w, t.args![0]!, it)
        return
      }
      default: {
        if (v instanceof Uint8Array && !(v as any)._) return void w.raw(Buffer.from(v))
        const c = this.byName.get(v?._)
        if (!c) throw new TLError(`Objek TL tidak dikenal: ${v?._ ?? typeof v} (tipe ${t.name})`)
        if (!t.bare) w.uint(c.id)
        this.writeParams(w, c, v)
      }
    }
  }

  /* ---- deserialize ---- */
  /** Baca nilai bertipe `t` (mis. hasil fungsi). */
  read(r: Reader, t: TypeRef): any {
    switch (t.name) {
      case 'int': return r.int()
      case 'long': return r.long()
      case 'double': return r.double()
      case 'string': return r.string()
      case 'bytes': return r.bytes()
      case 'int128': return Buffer.from(r.raw(16))
      case 'int256': return Buffer.from(r.raw(32))
      case 'true': return true
      case 'Bool': { const id = r.uint(); if (id === ID_TRUE) return true; if (id === ID_FALSE) return false; throw new TLError('Bool tidak valid') }
      case 'Vector': {
        if (!t.bare) {
          const id = r.uint()
          if (id === ID_GZIP) return this.read(new Reader(zlib.gunzipSync(r.bytes())), t)
          if (id !== ID_VECTOR) throw new TLError(`Vector diharapkan, dapat 0x${id.toString(16)}`)
        }
        const n = r.int()
        const out: any[] = []
        for (let i = 0; i < n; i++) out.push(this.read(r, t.args![0]!))
        return out
      }
      case 'Object': case 'X': return this.readObject(r)
      default: return t.bare ? this.readCtorBody(r, undefined) : this.readObject(r)
    }
  }

  readObject(r: Reader): any {
    const id = r.uint()
    if (id === ID_GZIP) return this.readObject(new Reader(zlib.gunzipSync(r.bytes())))
    if (id === ID_TRUE) return true
    if (id === ID_FALSE) return false
    if (id === ID_VECTOR) {
      const n = r.int(); const out: any[] = []
      for (let i = 0; i < n; i++) out.push(this.readObject(r))
      return out
    }
    return this.readCtorBody(r, id)
  }

  private readCtorBody(r: Reader, id: number | undefined): any {
    const c = id === undefined ? undefined : this.byId.get(id)
    if (!c) throw new TLError(`Konstruktor tidak dikenal 0x${(id ?? 0).toString(16)} (schema/layer tidak cocok?)`)
    const obj: any = { _: c.name }
    const flags: Record<string, number> = {}
    for (const p of c.params) {
      if (p.type.name === '#') { flags[p.name] = r.uint(); obj[p.name] = flags[p.name]; continue }
      if (p.flagField && !((flags[p.flagField]! >>> p.flagBit!) & 1)) {
        if (p.type.name === 'true') obj[p.name] = false
        continue
      }
      obj[p.name] = this.read(r, p.type)
    }
    return obj
  }

  deserialize(buf: Buffer) { return this.readObject(new Reader(buf)) }
}
