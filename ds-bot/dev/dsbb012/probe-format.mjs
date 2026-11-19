import { sessionFormatCatalog } from '../../../app/node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js'
const c = sessionFormatCatalog
console.log('currentVersion', c.currentVersion)
const enc = e => JSON.stringify(c.encodeCurrentEvent(e))
console.log('user/message:', enc({ type:'user/message', seq:0, time:1700000000000, data:{ role:'user', content:'hello', source:{kind:'user'} } }))
console.log('turn/start:', enc({ type:'turn/start', seq:1, time:1700000000001, data:{ turn:1 } }))
console.log('assistant:', enc({ type:'assistant/message', seq:2, time:1700000000002, data:{ role:'assistant', content:[{type:'text',text:'hi'}], stream:[{type:'text',text:'hi'}] } }).slice(0,240))
const h = c.encodeCurrentHeader({ type:'session', version:4, id:'session-abc', createdAt:1700000000000, isSeeded:false, delegationDepth:0, cwd:'C:/old-project', agentPreset:'standard' }, 0)
console.log('header:', JSON.stringify(h))
