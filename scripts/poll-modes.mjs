import TuyAPI from 'tuyapi'
import { readFileSync } from 'node:fs'

const fans = JSON.parse(readFileSync(process.env.KEYS_FILE, 'utf8'))

for (const f of fans) {
  const d = new TuyAPI({ id: f.id, key: f.key, ip: f.lanIp, version: '3.3' })
  d.on('error', () => {})
  const t = setTimeout(() => { console.log(`${f.name.padEnd(20)} TIMEOUT`); d.disconnect() }, 8000)
  try {
    await d.connect()
    const r = await d.get({ schema: true })
    clearTimeout(t)
    console.log(`${f.name.padEnd(20)} ${JSON.stringify(r.dps)}`)
  } catch (e) {
    clearTimeout(t)
    console.log(`${f.name.padEnd(20)} ERR ${e.message}`)
  }
  d.disconnect()
}
process.exit(0)
