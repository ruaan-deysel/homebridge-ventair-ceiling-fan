import TuyAPI from 'tuyapi'

const d = new TuyAPI({ id: process.env.FAN_ID, key: process.env.FAN_KEY, ip: process.env.FAN_IP, version: '3.3' })
d.on('error', e => console.error('  err:', e.message))

let pushed = null
d.on('data', x => { if (x?.dps) pushed = x.dps })
d.on('dp-refresh', x => { if (x?.dps) pushed = x.dps })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const read = async () => (await d.get({ schema: true })).dps

await d.connect()
console.log('ORIGINAL:', JSON.stringify(await read()))

for (const candidate of ['Nature', 'Smart', 'Sleep', 'Normal']) {
  pushed = null
  await d.set({ dps: 2, set: candidate, shouldWaitForResponse: false })
  await sleep(3000)
  const polled = await read()
  console.log(`set "${candidate}"  polled="${polled['2']}"  pushed=${pushed ? JSON.stringify(pushed) : 'none'}`)
  await sleep(1000)
}

await d.set({ dps: 2, set: 'Normal', shouldWaitForResponse: false })
await sleep(2000)
console.log('FINAL:', JSON.stringify(await read()))
d.disconnect()
process.exit(0)
