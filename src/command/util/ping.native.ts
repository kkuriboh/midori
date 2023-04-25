import { Command } from '@/app/command.ts'
import { dayjs, harmony, t } from '@/deps.ts'

const Ping = new Command({
  name: 'ping',
  description: 'command.ping.description',
  aliases: ['latency'],
  coolDown: 1000 * 4,
  execute: async (message) => {
    const embed = new harmony.Embed()
      .setColor(Deno.env.get('EMBED_COLOR') || '#57FF9A')
      .setDescription(t(message.locale, 'command.ping.reply', { latency: message.client.gateway.ping, processing: dayjs(dayjs().unix() - dayjs(message.timestamp).unix()).millisecond() }))
      
    await message.channel.send(embed)
  },
  afterExecute: async (message) => {
    await message.triggerCoolDown()
  }
})

export default Ping
