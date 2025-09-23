import { USER_ID } from '@/lib/constants'
import { deleteReminders, getDeleteAt, getRemindAt } from '@/lib/item'
import { parseInternalLinks } from '@/lib/url'

export async function getMentions ({ text }, { me, tx }) {
  const mentionPattern = /\B@[\w_]+/gi

  // collect first occurrence of each token as typed by the author (preserve case)
  const tokenMap = new Map()
  const matches = text.match(mentionPattern) || []
  for (const m of matches) {
    const token = m.slice(1) // drop leading '@'
    const key = token.toLowerCase()
    if (!tokenMap.has(key)) tokenMap.set(key, token)
  }

  if (tokenMap.size > 0) {
    // find matching users by case-insensitive name; exclude author/anon
    const users = await tx.user.findMany({
      where: {
        name: {
          in: Array.from(tokenMap.keys()) // citext => case-insensitive
        },
        id: {
          not: me?.id || USER_ID.anon
        }
      }
    })
    // store the immutable userId and the originally typed token (nym)
    return users.map(user => ({
      userId: user.id,
      nym: tokenMap.get(user.name.toLowerCase()) || user.name
    }))
  }
  return []
}

export const getItemMentions = async ({ text }, { me, tx }) => {
  const linkPattern = new RegExp(`${process.env.NEXT_PUBLIC_URL}/items/\\d+[a-zA-Z0-9/?=]*`, 'gi')
  const refs = text.match(linkPattern)?.map(m => {
    try {
      const { itemId, commentId } = parseInternalLinks(m)
      return Number(commentId || itemId)
    } catch (err) {
      return null
    }
  }).filter(r => !!r)

  if (refs?.length > 0) {
    const referee = await tx.item.findMany({
      where: {
        id: { in: refs },
        userId: { not: me?.id || USER_ID.anon }
      }
    })
    return referee.map(r => ({ refereeId: r.id }))
  }

  return []
}

export async function performBotBehavior ({ text, id }, { me, tx }) {
  // delete any existing deleteItem or reminder jobs for this item
  const userId = me?.id || USER_ID.anon
  id = Number(id)
  await tx.$queryRaw`
    DELETE FROM pgboss.job
    WHERE name = 'deleteItem'
    AND data->>'id' = ${id}::TEXT
    AND state <> 'completed'`
  await deleteReminders({ id, userId, models: tx })

  if (text) {
    const deleteAt = getDeleteAt(text)
    if (deleteAt) {
      await tx.$queryRaw`
        INSERT INTO pgboss.job (name, data, startafter, keepuntil)
        VALUES (
          'deleteItem',
          jsonb_build_object('id', ${id}::INTEGER),
          ${deleteAt}::TIMESTAMP WITH TIME ZONE,
          ${deleteAt}::TIMESTAMP WITH TIME ZONE + interval '1 minute')`
    }

    const remindAt = getRemindAt(text)
    if (remindAt) {
      await tx.$queryRaw`
        INSERT INTO pgboss.job (name, data, startafter, keepuntil)
        VALUES (
          'reminder',
          jsonb_build_object('itemId', ${id}::INTEGER, 'userId', ${userId}::INTEGER),
          ${remindAt}::TIMESTAMP WITH TIME ZONE,
          ${remindAt}::TIMESTAMP WITH TIME ZONE + interval '1 minute')`
      await tx.reminder.create({
        data: {
          userId,
          itemId: Number(id),
          remindAt
        }
      })
    }
  }
}
