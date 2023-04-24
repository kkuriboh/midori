import Logger from '@/app/core/logger.ts'
import { client } from '@/app/client.ts'
import { EventListener } from '@/app/event.ts'
import {
  Command,
  CommandOptions,
  commands,
  NormalMessage,
} from '@/app/command.ts'
import { ensureCache } from '@/app/cache.ts'

import { argParser, dayjs, harmony, t } from '@/deps.ts'
import {
  isNormalMessage,
  resolveArgument,
  resolvePositionalArgument,
safeAddReaction,
safeRemoveReactions,
sendErrorEmbed,
sendSuccessEmbed,
safeSendMessage
} from '@/namespace/utils.native.ts'

const logger = new Logger({
  logLevel: Deno.env.get('LOG_LEVEL') as any || 'debug',
  prefix: 'CommandHandler',
})

const coolDownCache = ensureCache<dayjs.Dayjs>(
  'cooldown',
  Number(Deno.env.get('MAX_COOLDOWN') || 1000 * 60 * 30),
)
const globalCoolDownCache = ensureCache<dayjs.Dayjs>(
  'globalCooldown',
  Number(Deno.env.get('MAX_COOLDOWN') || 1000 * 60 * 30),
)

function resolveRoleCoolDown(
  roles?: string[],
  options?: CommandOptions<'all'>,
) {
  if (!roles) return options?.globalCoolDown || options?.coolDown || 0
  if (!options?.roleCoolDown) {
    return options?.globalCoolDown || options?.coolDown || 0
  }

  let smallestCoolDown: number = options?.globalCoolDown || options?.coolDown ||
    0

  for (const roleCD of options.roleCoolDown) {
    if (roles.includes(roleCD.role.toLowerCase())) {
      if (smallestCoolDown > roleCD.coolDown) {
        smallestCoolDown = roleCD.coolDown
      }
    }
  }

  return smallestCoolDown
}

const event: EventListener<'messageCreate'> = {
  description: 'Manage message commands',
  once: false,
  execute: async (message) => {
    if (!isNormalMessage(message)) return

    const isSelfMention = new RegExp(`<@!?${message.client?.user?.id}>$`).test(message.content)
    const prefix = client.prefix.toString()

    if (!message.content.startsWith(prefix) && !isSelfMention) return

    const key = message.content.split(/\s+/)[0].slice(prefix.length)
    const cmd: Command<any> | undefined = commands.resolve(key)

    message.isFromBotOwner = message.author.id === Deno.env.get('BOT_OWNER')
    message.isFromGuildOwner = message?.guild?.ownerID === message.author.id || message.guild?.ownerID === message.author.id
    message.args = {}
    message.positionalArgs = {}
     

    message.locale =
      (await message?.member?.roles.array())?.find((role) =>
        role.name.startsWith('lang:')
      )?.name.replace('lang:', '') || Deno.env.get('BOT_DEFAULT_LOCALE') ||
      'en-US'
      
    if (isSelfMention) {
      console.log('Mentioned midori')
      return await sendSuccessEmbed(message, 'generic.mention', { prefix })
    }

    if (!cmd) return

    message.triggerCoolDown = async () => {
      if (cmd.options.globalCoolDown) {
        globalCoolDownCache.set(
          `${cmd.options.name}`,
          dayjs.unix(cmd.options.globalCoolDown),
        )
      }

      if (cmd.options.coolDown) {
        coolDownCache.set(
          `${message.author.id}.${cmd.options.name}`,
          dayjs().add(cmd.options.coolDown, 'milliseconds'),
        )
      }

      if (cmd.options.roleCoolDown) {
        const userRoles = (await message?.member?.roles.array())?.map(
          (role) => role.name.toLowerCase(),
        )
        const roleCD = resolveRoleCoolDown(userRoles, cmd.options)
        coolDownCache.set(
          `${message.author.id}.${cmd.options.name}`,
          dayjs().add(roleCD, 'milliseconds'),
        )
      }
    }

    // Check if the user has all needed permissions
    if (cmd.options.requiredPermissions) {
      const hasPermissions = cmd.options.requiredPermissions.every((perm) =>
        message.member?.permissions.has(perm)
      ) || message.isFromBotOwner

      if (!hasPermissions) {
        return await sendErrorEmbed(message, 'command.error.noPermissions')
      }
    }

    // check if the user has any of the needed roles
    if (cmd.options?.allowedRoles) {
      const userRoles = await message.member?.roles.array()
      const hasRoles = cmd.options.allowedRoles.some((role) =>
        userRoles?.some((r) => r.name === role)
      ) || message.isFromBotOwner

      if (!hasRoles) {
        return await sendErrorEmbed(message, 'command.error.noRoles')
      }
    }

    const cleanContent = message.content.slice(prefix.length + key.length)
      .trim()

    // TRY EVERYTHING
    try {
      try {
        const parsedArgs = argParser(cleanContent)
        const positionalObject = resolvePositionalArgument(
          parsedArgs._,
          cmd.options.positionalArgs,
        )
        const argsObject = resolveArgument(parsedArgs, cmd.options.args)
  
        parsedArgs._.forEach((arg, index) => {
          const cmdPositionals = cmd.options.positionalArgs
          const reference = cmdPositionals?.[index]
  
          if (reference) {
            positionalObject[reference.name] = arg
          }
        })

        message.positionalArgs = positionalObject
        message.args = argsObject
  
        if (parsedArgs.help || parsedArgs.h || positionalObject.help) {
          return await message.channel.send({
            embeds: [
              new harmony.Embed()
                .setColor(Deno.env.get('EMBED_COLOR') || '#57FF9A')
                .setDescription('HELP FUNCTION'),
            ],
          })
        }
      } catch (e) {
        await safeRemoveReactions(message)
        await safeAddReaction(message, ':bot_fail:1077894898331697162')
        await sendErrorEmbed(message, e.message)
      }


      message.send = async function (
        this: NormalMessage,
        sent: string | harmony.AllMessageOptions,
      ) {
        return await this.channel.send(sent)
      }.bind(message)

      // TRY COOLDOWN
      try {
        if (
          (cmd.options.coolDown || cmd.options.roleCoolDown) &&
          !message.isFromBotOwner
        ) {
          const coolDown =
            coolDownCache.get(`${message.author.id}.${cmd.options.name}`) ||
            globalCoolDownCache.get(`${cmd.options.name}`)
          const userRoles = (await message?.member?.roles.array())?.map(
            (role) => role.name.toLowerCase(),
          )

          if (
            coolDown &&
            (
              coolDown?.unix() > dayjs()?.unix() ||
              coolDown?.unix() >
                dayjs()?.add(
                  resolveRoleCoolDown(userRoles, cmd.options),
                  'milliseconds',
                )?.unix()
            )
          ) {
            throw new Error(`error.command.coolDown`)
          }
        }
      } catch (e) {
        await safeRemoveReactions(message)
        await safeAddReaction(message, '1077894898331697162')
        return await sendErrorEmbed(message)
      }

      await safeAddReaction(message, 'a:bot_loading:1077896860456472598')
      await cmd.options?.beforeExecute?.bind(cmd)(message)

      cmd.options.execute.bind(cmd)(message)
        ?.then(async () => {
          await safeRemoveReactions(message)
          await safeAddReaction(message, 'a:bot_loaded:1077896425570046044')
          await cmd.options.afterExecute?.bind(cmd)(message)
        })
        ?.catch((e) => {
          cmd.options.onError?.bind(cmd)(message, e)
        })
    } catch (e) {
      logger.error(`Error while handling command ${cmd.options.name} execution`)
      console.error(e)
      await message.reactions.removeAll()
      await safeAddReaction(message, '1077894898331697162')
      await sendErrorEmbed(message)
    }
  },
}

export default event
