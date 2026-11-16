import { EventEmitter } from 'events'
import * as net from 'net'

/** TCP "Intermediate" transport: [len LE 4][payload]. */
export class Transport extends EventEmitter {
  private socket?: net.Socket
  private buf: Buffer = Buffer.alloc(0)
  connected = false

  connect(host: string, port: number, timeoutMs = 15000): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host, port })
      this.socket = s
      s.setNoDelay(true)
      s.setTimeout(timeoutMs, () => s.destroy(new Error('Timeout koneksi ke ' + host)))
      s.once('connect', () => {
        s.setTimeout(0)
        s.write(Buffer.from([0xee, 0xee, 0xee, 0xee]))
        this.connected = true
        resolve()
      })
      s.on('data', (d: Buffer) => this.onData(d))
      s.on('error', (e) => { if (!this.connected) reject(e); this.emit('error', e) })
      s.on('close', () => { const was = this.connected; this.connected = false; if (was) this.emit('close') })
    })
  }

  private onData(d: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d
    for (;;) {
      if (this.buf.length < 4) return
      const len = this.buf.readUInt32LE(0)
      if (len & 0x80000000) { this.buf = this.buf.subarray(4); continue } // quick-ack, diabaikan
      if (this.buf.length < 4 + len) return
      const pkt = Buffer.from(this.buf.subarray(4, 4 + len))
      this.buf = this.buf.subarray(4 + len)
      if (pkt.length === 4) { this.emit('transportError', pkt.readInt32LE(0)); continue }
      this.emit('packet', pkt)
    }
  }

  send(payload: Buffer) {
    const h = Buffer.alloc(4); h.writeUInt32LE(payload.length)
    this.socket?.write(Buffer.concat([h, payload]))
  }

  close() { this.connected = false; this.socket?.destroy() }
}
