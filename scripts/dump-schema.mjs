import TuyAPI from 'tuyapi'

const device = new TuyAPI({
  id: process.env.FAN_ID,
  key: process.env.FAN_KEY,
  ip: process.env.FAN_IP,
  version: '3.3',
  issueRefreshOnConnect: true,
})

device.on('error', e => console.error('error:', e.message))

const timeout = setTimeout(() => {
  console.error('timed out after 20s')
  process.exit(1)
}, 20000)

try {
  await device.connect()
  console.log('=== get({schema:true}) ===')
  console.log(JSON.stringify(await device.get({ schema: true }), null, 2))
  console.log('=== refresh ===')
  console.log(JSON.stringify(await device.refresh({}), null, 2))
} catch (e) {
  console.error('failed:', e.message)
} finally {
  clearTimeout(timeout)
  device.disconnect()
  process.exit(0)
}
