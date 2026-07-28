import TuyAPI from 'tuyapi'

const d = new TuyAPI({ id: process.env.FAN_ID, key: process.env.FAN_KEY, ip: process.env.FAN_IP, version: '3.3' })
d.on('error', e => console.error('  err:', e.message))

const read = async () => (await d.get({ schema: true })).dps
const sleep = ms => new Promise(r => setTimeout(r, ms))

await d.connect()
const original = await read()
console.log('ORIGINAL:', JSON.stringify(original))
if (original['1'] !== false) { console.error('ABORT: fan is ON, refusing to probe'); d.disconnect(); process.exit(1) }

for (const candidate of ['nature', 'sleep', 'smart', 'Nature', 'Sleep', 'Smart']) {
  try {
    await d.set({ dps: 2, set: candidate, shouldWaitForResponse: false })
    await sleep(1200)
    const now = await read()
    console.log(`  set "${candidate}" -> device reports "${now['2']}"  (power=${now['1']})`)
  } catch (e) {
    console.log(`  set "${candidate}" -> REJECTED: ${e.message}`)
  }
}

console.log('--- restoring ---')
await d.set({ dps: 2, set: original['2'], shouldWaitForResponse: false })
await sleep(1500)
const final = await read()
console.log('FINAL:', JSON.stringify(final))
console.log(final['2'] === original['2'] && final['1'] === original['1'] ? 'RESTORED OK' : '*** NOT RESTORED ***')
d.disconnect()
process.exit(0)
